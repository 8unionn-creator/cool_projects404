package explain

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"

	"github.com/anthropics/anthropic-sdk-go/option"
)

// mockAPI imitates the Messages API's streaming responses.
func mockAPI(t *testing.T, stop string, chunks ...string) (*httptest.Server, *atomic.Int32, *map[string]any, *http.Header) {
	t.Helper()
	var hits atomic.Int32
	body := map[string]any{}
	headers := http.Header{}
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		hits.Add(1)
		b, _ := io.ReadAll(r.Body)
		json.Unmarshal(b, &body)
		headers = r.Header.Clone()
		if stop == "429" {
			w.Header().Set("Content-Type", "application/json")
			w.WriteHeader(429)
			fmt.Fprint(w, `{"type":"error","error":{"type":"rate_limit_error","message":"slow down"}}`)
			return
		}
		w.Header().Set("Content-Type", "text/event-stream")
		send := func(event, data string) { fmt.Fprintf(w, "event: %s\ndata: %s\n\n", event, data) }
		send("message_start", `{"type":"message_start","message":{"id":"msg_1","type":"message","role":"assistant","model":"claude-opus-5-5","content":[],"stop_reason":null,"stop_sequence":null,"usage":{"input_tokens":10,"output_tokens":1}}}`)
		send("content_block_start", `{"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}`)
		for _, c := range chunks {
			js, _ := json.Marshal(c)
			send("content_block_delta", `{"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":`+string(js)+`}}`)
		}
		send("content_block_stop", `{"type":"content_block_stop","index":0}`)
		send("message_delta", `{"type":"message_delta","delta":{"stop_reason":"`+stop+`","stop_sequence":null},"usage":{"output_tokens":5}}`)
		send("message_stop", `{"type":"message_stop"}`)
	}))
	t.Cleanup(srv.Close)
	return srv, &hits, &body, &headers
}

func TestExplainStreamsCachesAndSendsTheRightRequest(t *testing.T) {
	srv, hits, body, headers := mockAPI(t, "end_turn", "This file ", "opens the `DB`.")
	e := New(t.TempDir(), option.WithBaseURL(srv.URL), option.WithAPIKey("test-key"), option.WithMaxRetries(0))
	var got strings.Builder
	req := Request{Kind: File, Overview: "Repository overview", Material: "File: db.go\n```go\npackage db\n```"}
	text, cached, err := e.Explain(context.Background(), req, func(s string) { got.WriteString(s) })
	if err != nil {
		t.Fatal(err)
	}
	if text != "This file opens the `DB`." || got.String() != text || cached {
		t.Fatalf("text=%q streamed=%q cached=%v", text, got.String(), cached)
	}

	b := *body
	if b["model"] != "claude-opus-5-5" || b["stream"] != true || b["fallbacks"] != "default" {
		t.Errorf("request body: model=%v stream=%v fallbacks=%v", b["model"], b["stream"], b["fallbacks"])
	}
	if oc, _ := b["output_config"].(map[string]any); oc["effort"] != "low" {
		t.Errorf("effort = %v", b["output_config"])
	}
	sys, _ := b["system"].([]any)
	if len(sys) != 2 {
		t.Fatalf("system blocks = %v", b["system"])
	}
	if cc, _ := sys[1].(map[string]any)["cache_control"].(map[string]any); cc["type"] != "ephemeral" {
		t.Errorf("the overview should be cached: %v", sys[1])
	}
	if !strings.Contains(headers.Get("Anthropic-Beta"), "server-side-fallback-2026-07-01") {
		t.Errorf("beta header = %q", headers.Get("Anthropic-Beta"))
	}

	// The same question again comes from the local cache: no API call.
	got.Reset()
	text2, cached, err := e.Explain(context.Background(), req, func(s string) { got.WriteString(s) })
	if err != nil || !cached || text2 != text || hits.Load() != 1 {
		t.Fatalf("second call: cached=%v hits=%d err=%v", cached, hits.Load(), err)
	}
	// Different material is a different question.
	req.Material += "\n// changed"
	if _, cached, _ := e.Explain(context.Background(), req, func(string) {}); cached || hits.Load() != 2 {
		t.Fatalf("changed material must not hit the cache (hits=%d)", hits.Load())
	}
}

func TestExplainErrors(t *testing.T) {
	srv, _, _, _ := mockAPI(t, "refusal", "")
	e := New(t.TempDir(), option.WithBaseURL(srv.URL), option.WithAPIKey("k"), option.WithMaxRetries(0))
	if _, _, err := e.Explain(context.Background(), Request{Kind: Step, Material: "x"}, func(string) {}); err == nil || !strings.Contains(err.Error(), "declined") {
		t.Fatalf("refusal: %v", err)
	}
	srv2, _, _, _ := mockAPI(t, "429")
	e2 := New(t.TempDir(), option.WithBaseURL(srv2.URL), option.WithAPIKey("k"), option.WithMaxRetries(0))
	if _, _, err := e2.Explain(context.Background(), Request{Kind: Tour, Material: "x"}, func(string) {}); err == nil || !strings.Contains(err.Error(), "rate limited") {
		t.Fatalf("429: %v", err)
	}
	if _, _, err := e2.Explain(context.Background(), Request{Kind: "poem"}, func(string) {}); err == nil {
		t.Fatal("unknown kinds should be rejected")
	}
}

func TestModelAndEffortOverrides(t *testing.T) {
	t.Setenv("REWIND_MODEL", "claude-sonnet-5-5")
	t.Setenv("REWIND_EFFORT", "high")
	e := New(t.TempDir())
	if e.Model != "claude-sonnet-5-5" || e.Effort != "high" {
		t.Fatalf("model=%s effort=%s", e.Model, e.Effort)
	}
	t.Setenv("REWIND_EFFORT", "extreme")
	if New(t.TempDir()).Effort != "low" {
		t.Fatal("invalid effort should fall back to the default")
	}
}
