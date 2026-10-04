package hook

import (
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strconv"
	"strings"
)

// MCPFiles lists where each agent reads project MCP servers from,
// relative to the repository root.
var MCPFiles = map[string]string{
	"claude": ".mcp.json",
	"codex":  ".codex/config.toml",
	"gemini": ".gemini/settings.json",
	"cursor": ".cursor/mcp.json",
}

// MCPNotes says what the user still has to do after the server is added.
var MCPNotes = map[string]string{
	"claude": ".mcp.json is meant to be committed; commit it only if everyone on the project has rewind installed.",
	"codex":  "Codex reads .codex/config.toml only in projects you trust.",
}

// InstallMCP registers `<bin> mcp` as the "rewind" MCP server for an agent.
// An existing "rewind" entry is left alone. It returns whether it added one.
func InstallMCP(agent, root, bin string) (bool, error) {
	rel, ok := MCPFiles[agent]
	if !ok {
		return false, fmt.Errorf("unknown agent %q", agent)
	}
	file := filepath.Join(root, filepath.FromSlash(rel))
	args := []string{"mcp"}
	if agent == "cursor" {
		// Cursor may start servers outside the project; it expands this.
		args = append(args, "--repo", "${workspaceFolder}")
	}
	if agent == "codex" {
		return installTOML(file, bin, args)
	}
	added, err := editJSON(file, func(m map[string]any) bool {
		servers, _ := m["mcpServers"].(map[string]any)
		if servers == nil {
			servers = map[string]any{}
		}
		if _, ok := servers["rewind"]; ok {
			return false
		}
		servers["rewind"] = map[string]any{"command": bin, "args": args}
		m["mcpServers"] = servers
		return true
	})
	if err != nil || agent != "claude" {
		return added, err
	}
	// Claude Code asks before starting a server from .mcp.json; approve ours
	// in the same (uncommitted) settings file the hooks go into.
	_, err = editJSON(filepath.Join(root, ".claude", "settings.local.json"), func(m map[string]any) bool {
		list, _ := m["enabledMcpjsonServers"].([]any)
		for _, x := range list {
			if x == "rewind" {
				return false
			}
		}
		m["enabledMcpjsonServers"] = append(list, "rewind")
		return true
	})
	return added, err
}

// editJSON loads a JSON object file (missing is empty), lets edit change
// it, and writes it back if edit reports a change.
func editJSON(file string, edit func(map[string]any) bool) (bool, error) {
	m := map[string]any{}
	b, err := os.ReadFile(file)
	switch {
	case err == nil:
		if len(strings.TrimSpace(string(b))) > 0 {
			if err := json.Unmarshal(b, &m); err != nil {
				return false, fmt.Errorf("%s is not valid JSON: %w", file, err)
			}
		}
	case !errors.Is(err, os.ErrNotExist):
		return false, err
	}
	if !edit(m) {
		return false, nil
	}
	out, err := json.MarshalIndent(m, "", "  ")
	if err != nil {
		return false, err
	}
	if err := os.MkdirAll(filepath.Dir(file), 0o755); err != nil {
		return false, err
	}
	return true, os.WriteFile(file, append(out, '\n'), 0o644)
}

// installTOML appends a [mcp_servers.rewind] table to a Codex config file.
func installTOML(file, bin string, args []string) (bool, error) {
	b, err := os.ReadFile(file)
	if err != nil && !errors.Is(err, os.ErrNotExist) {
		return false, err
	}
	text := string(b)
	for _, line := range strings.Split(text, "\n") {
		if l := strings.ReplaceAll(strings.TrimSpace(line), " ", ""); l == "[mcp_servers.rewind]" || l == `[mcp_servers."rewind"]` {
			return false, nil
		}
	}
	quoted := make([]string, len(args))
	for i, a := range args {
		quoted[i] = strconv.Quote(a)
	}
	if text != "" && !strings.HasSuffix(text, "\n") {
		text += "\n"
	}
	if text != "" {
		text += "\n"
	}
	text += fmt.Sprintf("[mcp_servers.rewind]\ncommand = %s\nargs = [%s]\n", strconv.Quote(bin), strings.Join(quoted, ", "))
	if err := os.MkdirAll(filepath.Dir(file), 0o755); err != nil {
		return false, err
	}
	return true, os.WriteFile(file, []byte(text), 0o644)
}
