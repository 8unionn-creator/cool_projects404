// Package explain asks Claude to explain code: a file, a folder, an agent
// step, or a guided tour of the whole repository.
//
// It is opt-in: nothing is sent anywhere unless the user asks for an
// explanation, and only when Anthropic credentials are configured
// (ANTHROPIC_API_KEY, ANTHROPIC_AUTH_TOKEN, or an `ant auth login` profile).
// Answers are cached under .git/rewind/explain by a hash of everything that
// went into the request, so asking again about unchanged code is free.
package explain

import (
	"context"
	"crypto/sha256"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"

	"github.com/anthropics/anthropic-sdk-go"
	"github.com/anthropics/anthropic-sdk-go/option"
)

// Kind is what is being explained.
type Kind string

// Kinds of explanation.
const (
	File   Kind = "file"
	Folder Kind = "folder"
	Step   Kind = "step"
	Tour   Kind = "tour"
)

const (
	defaultModel  = "claude-opus-5-5"
	promptVersion = "1" // bump to invalidate cached answers when prompts change
	maxTokens     = 16000
)

// Request is one explanation to produce.
type Request struct {
	Kind     Kind
	Overview string // a summary of the whole repository, shared across requests (cached by the API)
	Material string // what to explain: source, file lists, a diff...
}

// Explainer talks to Claude.
type Explainer struct {
	Model    string
	Effort   anthropic.OutputConfigEffort
	cacheDir string
	opts     []option.RequestOption

	// stream is replaced in tests.
	stream func(ctx context.Context, system []anthropic.TextBlockParam, user string, onText func(string)) (string, error)
}

// New returns an explainer that caches answers in gitDir/rewind/explain.
// REWIND_MODEL and REWIND_EFFORT override the model and effort.
func New(gitDir string, opts ...option.RequestOption) *Explainer {
	e := &Explainer{
		Model:    defaultModel,
		Effort:   anthropic.OutputConfigEffortLow, // short explanations don't need deep thinking
		cacheDir: filepath.Join(gitDir, "rewind", "explain"),
		opts:     opts,
	}
	if m := os.Getenv("REWIND_MODEL"); m != "" {
		e.Model = m
	}
	switch v := anthropic.OutputConfigEffort(os.Getenv("REWIND_EFFORT")); v {
	case anthropic.OutputConfigEffortLow, anthropic.OutputConfigEffortMedium, anthropic.OutputConfigEffortHigh,
		anthropic.OutputConfigEffortXhigh, anthropic.OutputConfigEffortMax:
		e.Effort = v
	}
	e.stream = e.callClaude
	return e
}

// Configured reports whether Anthropic credentials appear to be set up.
func Configured() bool {
	if os.Getenv("ANTHROPIC_API_KEY") != "" || os.Getenv("ANTHROPIC_AUTH_TOKEN") != "" || os.Getenv("ANTHROPIC_PROFILE") != "" {
		return true
	}
	if dir, err := os.UserConfigDir(); err == nil {
		if _, err := os.Stat(filepath.Join(dir, "anthropic")); err == nil {
			return true
		}
	}
	if home, err := os.UserHomeDir(); err == nil {
		if _, err := os.Stat(filepath.Join(home, ".config", "anthropic")); err == nil {
			return true
		}
	}
	return false
}

// SetupHelp tells the user how to turn explanations on.
const SetupHelp = "Explanations use the Claude API. Set ANTHROPIC_API_KEY (create a key at console.anthropic.com) " +
	"or run `ant auth login`, then restart rewind. Code is sent to Anthropic only when you ask for an explanation."

// Explain streams an explanation through onText and returns it. cached
// reports whether it came from the local cache.
func (e *Explainer) Explain(ctx context.Context, req Request, onText func(string)) (text string, cached bool, err error) {
	user := instructions[req.Kind]
	if user == "" {
		return "", false, fmt.Errorf("unknown explanation kind %q", req.Kind)
	}
	user += "\n\n" + req.Material

	sum := sha256.Sum256([]byte(strings.Join([]string{promptVersion, e.Model, string(e.Effort), system, req.Overview, user}, "\x00")))
	path := filepath.Join(e.cacheDir, fmt.Sprintf("%x.md", sum[:16]))
	if b, err := os.ReadFile(path); err == nil {
		onText(string(b))
		return string(b), true, nil
	}

	blocks := []anthropic.TextBlockParam{{Text: system}}
	if req.Overview != "" {
		// The overview is identical for every request about the same
		// snapshot, so it is cached: follow-up questions read it at a
		// fraction of the price.
		blocks = append(blocks, anthropic.TextBlockParam{Text: req.Overview, CacheControl: anthropic.NewCacheControlEphemeralParam()})
	}
	text, err = e.stream(ctx, blocks, user, onText)
	if err != nil {
		return text, false, err
	}
	if err := os.MkdirAll(e.cacheDir, 0o755); err == nil {
		_ = os.WriteFile(path, []byte(text), 0o644)
	}
	return text, false, nil
}

func (e *Explainer) callClaude(ctx context.Context, sys []anthropic.TextBlockParam, user string, onText func(string)) (string, error) {
	client := anthropic.NewClient(e.opts...)
	params := anthropic.MessageNewParams{
		Model:        anthropic.Model(e.Model),
		MaxTokens:    maxTokens,
		System:       sys,
		OutputConfig: anthropic.OutputConfigParam{Effort: e.Effort},
		Messages:     []anthropic.MessageParam{anthropic.NewUserMessage(anthropic.NewTextBlock(user))},
	}
	stream := client.Messages.NewStreaming(ctx, params,
		// If a safety classifier declines, the API re-serves the request
		// with a suitable fallback model inside the same call.
		option.WithHeaderAdd("anthropic-beta", "server-side-fallback-2026-07-01"),
		option.WithJSONSet("fallbacks", "default"),
	)
	var msg anthropic.Message
	var out strings.Builder
	for stream.Next() {
		ev := stream.Current()
		_ = msg.Accumulate(ev)
		if d, ok := ev.AsAny().(anthropic.ContentBlockDeltaEvent); ok {
			if t, ok := d.Delta.AsAny().(anthropic.TextDelta); ok {
				out.WriteString(t.Text)
				onText(t.Text)
			}
		}
	}
	if err := stream.Err(); err != nil {
		return out.String(), friendly(err)
	}
	switch msg.StopReason {
	case anthropic.StopReasonRefusal:
		return out.String(), errors.New("Claude declined to explain this code")
	case anthropic.StopReasonMaxTokens:
		onText("\n\n_(The explanation was cut off at the length limit.)_")
	}
	return out.String(), nil
}

// friendly turns API errors into messages that say what to do.
func friendly(err error) error {
	var apiErr *anthropic.Error
	if !errors.As(err, &apiErr) {
		if errors.Is(err, context.Canceled) {
			return errors.New("the explanation was cancelled")
		}
		return fmt.Errorf("could not reach the Claude API: %v", err)
	}
	switch apiErr.StatusCode {
	case 401:
		return errors.New("the Claude API rejected your credentials; check ANTHROPIC_API_KEY or run `ant auth login`")
	case 402:
		return errors.New("your Anthropic account needs billing set up or more credit (console.anthropic.com)")
	case 403:
		return errors.New("your API key is not allowed to use this model; set REWIND_MODEL to one it can use")
	case 404:
		return fmt.Errorf("model not found; check REWIND_MODEL (%v)", apiErr.Error())
	case 429:
		return errors.New("rate limited by the Claude API; wait a moment and try again")
	case 529, 503:
		return errors.New("the Claude API is overloaded right now; try again shortly")
	}
	return fmt.Errorf("the Claude API returned an error: %v", apiErr.Error())
}

const system = `You explain code to a developer who is working in this repository, often right after an AI coding agent changed it.

Write for someone skimming: lead with the answer, then the details that matter. Use short paragraphs and bullet points. Put file paths, functions and other identifiers in backticks, exactly as they appear, so they can be linked. Do not repeat the material back. If something looks wrong or risky, say so plainly and say why. If the material is not enough to be sure, say what you would need to check rather than guessing.`

var instructions = map[Kind]string{
	File:   `Explain the file below. Cover what it is for, its main pieces and how they work together, how it fits into the rest of the repository (who uses it, what it depends on), and anything surprising, fragile or risky. Keep it under 300 words.`,
	Folder: `Explain the folder below: what this part of the codebase is responsible for, how its files divide the work, how it connects to the rest of the repository, and where a newcomer should start reading. Keep it under 300 words.`,
	Step:   `An AI coding agent made the change below in response to the prompt shown. Explain what the step actually did, whether it matches what was asked, and anything to double-check before trusting it (behaviour changes, new dependencies or cycles, missing tests, edge cases). Keep it under 300 words.`,
	Tour:   `Give a guided tour of this repository for a developer seeing it for the first time. Start with two or three sentences on what the project does and how it is organised. Then give a numbered reading order of 6 to 10 files, one line each on why to read it at that point. End with the one or two things that are most likely to surprise a newcomer.`,
}
