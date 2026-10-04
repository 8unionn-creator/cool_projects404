package main

import (
	"bufio"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"runtime"
	"strconv"
	"strings"
	"time"
)

// Releases are published by .github/workflows/rewind-release.yml under
// tags named rewind-v<version>.
var (
	releasesAPI = "https://api.github.com/repos/8unionn-creator/cool_projects404/releases?per_page=30"
	tagPrefix   = "rewind-v"
)

type release struct {
	Tag        string `json:"tag_name"`
	Draft      bool   `json:"draft"`
	Prerelease bool   `json:"prerelease"`
	URL        string `json:"html_url"`
	Assets     []struct {
		Name string `json:"name"`
		URL  string `json:"browser_download_url"`
	} `json:"assets"`
}

func (r release) asset(name string) string {
	for _, a := range r.Assets {
		if a.Name == name {
			return a.URL
		}
	}
	return ""
}

func assetName() string {
	name := "rewind-" + runtime.GOOS + "-" + runtime.GOARCH
	if runtime.GOOS == "windows" {
		name += ".exe"
	}
	return name
}

func cmdUpdate(args []string, out io.Writer) error {
	fs := flag.NewFlagSet("update", flag.ContinueOnError)
	check := fs.Bool("check", false, "only say whether a newer version exists")
	force := fs.Bool("force", false, "reinstall even if this is the latest version")
	if err := parse(fs, args); err != nil {
		return err
	}
	client := &http.Client{Timeout: 2 * time.Minute}
	rel, err := latestRelease(client)
	if err != nil {
		return err
	}
	latest := strings.TrimPrefix(rel.Tag, tagPrefix)
	if !newer(latest, version) && !*force {
		fmt.Fprintf(out, "rewind %s is the latest version.\n", version)
		return nil
	}
	if *check {
		fmt.Fprintf(out, "rewind %s is available (you have %s). Run `rewind update` to install it.\n%s\n", latest, version, rel.URL)
		return nil
	}
	name := assetName()
	url := rel.asset(name)
	if url == "" {
		return fmt.Errorf("release %s has no build for %s/%s; download one from %s", rel.Tag, runtime.GOOS, runtime.GOARCH, rel.URL)
	}
	sums := rel.asset("checksums.txt")
	if sums == "" {
		return fmt.Errorf("release %s has no checksums.txt, so the download cannot be verified", rel.Tag)
	}
	want, err := checksum(client, sums, name)
	if err != nil {
		return err
	}
	exe, err := os.Executable()
	if err != nil {
		return err
	}
	if real, err := filepath.EvalSymlinks(exe); err == nil {
		exe = real
	}
	fmt.Fprintf(out, "Downloading rewind %s for %s/%s...\n", latest, runtime.GOOS, runtime.GOARCH)
	tmp := exe + ".new"
	if err := download(client, url, tmp, want); err != nil {
		os.Remove(tmp)
		return err
	}
	if err := replaceExe(exe, tmp); err != nil {
		os.Remove(tmp)
		return fmt.Errorf("installing %s: %w", exe, err)
	}
	fmt.Fprintf(out, "Updated %s from %s to %s.\n", exe, version, latest)
	fmt.Fprintln(out, "Restart open editors and agents so their hooks and MCP server use the new version.")
	return nil
}

func get(client *http.Client, url string) (*http.Response, error) {
	req, err := http.NewRequest("GET", url, nil)
	if err != nil {
		return nil, err
	}
	req.Header.Set("User-Agent", "rewind/"+version)
	if strings.Contains(url, "api.github.com") {
		req.Header.Set("Accept", "application/vnd.github+json")
		if tok := os.Getenv("GITHUB_TOKEN"); tok != "" {
			req.Header.Set("Authorization", "Bearer "+tok)
		}
	}
	resp, err := client.Do(req)
	if err != nil {
		return nil, err
	}
	if resp.StatusCode != 200 {
		resp.Body.Close()
		if resp.StatusCode == 404 && strings.Contains(url, "api.github.com") {
			return nil, errors.New("no releases found (if the repository is private, set GITHUB_TOKEN)")
		}
		return nil, fmt.Errorf("GET %s: %s", url, resp.Status)
	}
	return resp, nil
}

func latestRelease(client *http.Client) (release, error) {
	resp, err := get(client, releasesAPI)
	if err != nil {
		return release{}, err
	}
	defer resp.Body.Close()
	var list []release
	if err := json.NewDecoder(resp.Body).Decode(&list); err != nil {
		return release{}, fmt.Errorf("reading the release list: %w", err)
	}
	var best release
	for _, r := range list {
		if r.Draft || r.Prerelease || !strings.HasPrefix(r.Tag, tagPrefix) {
			continue
		}
		if best.Tag == "" || newer(strings.TrimPrefix(r.Tag, tagPrefix), strings.TrimPrefix(best.Tag, tagPrefix)) {
			best = r
		}
	}
	if best.Tag == "" {
		return release{}, errors.New("no rewind releases published yet")
	}
	return best, nil
}

func checksum(client *http.Client, url, name string) (string, error) {
	resp, err := get(client, url)
	if err != nil {
		return "", err
	}
	defer resp.Body.Close()
	sc := bufio.NewScanner(resp.Body)
	for sc.Scan() {
		f := strings.Fields(sc.Text())
		if len(f) == 2 && strings.TrimPrefix(f[1], "*") == name {
			return strings.ToLower(f[0]), nil
		}
	}
	return "", fmt.Errorf("checksums.txt does not list %s", name)
}

func download(client *http.Client, url, dst, sha string) error {
	resp, err := get(client, url)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	f, err := os.OpenFile(dst, os.O_CREATE|os.O_TRUNC|os.O_WRONLY, 0o755)
	if err != nil {
		return err
	}
	h := sha256.New()
	if _, err := io.Copy(io.MultiWriter(f, h), resp.Body); err != nil {
		f.Close()
		return err
	}
	if err := f.Close(); err != nil {
		return err
	}
	if got := hex.EncodeToString(h.Sum(nil)); got != sha {
		return fmt.Errorf("the download is corrupt (sha256 %s, expected %s); nothing was changed", got, sha)
	}
	return nil
}

// replaceExe swaps in the new binary. Windows cannot overwrite a running
// executable but can rename it, so the old one is moved aside first.
func replaceExe(exe, tmp string) error {
	if runtime.GOOS != "windows" {
		return os.Rename(tmp, exe)
	}
	old := exe + ".old"
	os.Remove(old) // left by the previous update
	if err := os.Rename(exe, old); err != nil {
		return err
	}
	if err := os.Rename(tmp, exe); err != nil {
		os.Rename(old, exe)
		return err
	}
	return nil
}

// newer reports whether version a is newer than b ("0.10.0" > "0.9.1").
func newer(a, b string) bool {
	pa, pb := strings.Split(a, "."), strings.Split(b, ".")
	for i := 0; i < len(pa) || i < len(pb); i++ {
		var x, y int
		if i < len(pa) {
			x, _ = strconv.Atoi(pa[i])
		}
		if i < len(pb) {
			y, _ = strconv.Atoi(pb[i])
		}
		if x != y {
			return x > y
		}
	}
	return false
}
