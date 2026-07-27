import { useCallback, useEffect, useRef, useState } from "react";
import { TextField, Spinner } from "@shopify/polaris";
import "../styles/curator-chat.css";

/** Histórico para a API — só a partir do primeiro turno do utilizador (Gemini exige user primeiro). */
function buildGeminiHistory(messages) {
  const turns = messages.filter((m) => m.role === "user" || m.role === "assistant");
  const firstUser = turns.findIndex((m) => m.role === "user");
  if (firstUser < 0) return [];

  return turns
    .slice(firstUser)
    .slice(-10)
    .map((m) => ({
      role: m.role === "user" ? "user" : "model",
      text: m.text,
    }));
}

/**
 * @param {{
 *   onApplyCatalogFilters?: (filters: {
 *     brand: string | null,
 *     search: string,
 *     licenceIds: string[],
 *     productTypeIds: string[],
 *     minPrice: string,
 *     maxPrice: string,
 *     inStockOnly: boolean,
 *   }) => void,
 * }} props
 */
export function CuratorChatWidget({ onApplyCatalogFilters }) {
  const [open, setOpen] = useState(false);
  const [input, setInput] = useState("");
  const [loading, setLoading] = useState(false);
  const [messages, setMessages] = useState([
    {
      role: "assistant",
      text: "Hello! I'm the Alterpop curation assistant. Ask about the catalog — e.g. «Show me Funko figures in stock».",
    },
  ]);
  const scrollRef = useRef(null);

  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [messages, loading, open]);

  const sendMessage = useCallback(async () => {
    const text = input.trim();
    if (!text || loading) return;

    const history = buildGeminiHistory(messages);

    setInput("");
    setMessages((prev) => [...prev, { role: "user", text }]);
    setLoading(true);

    try {
      const res = await fetch("/api/curator/chat", {
        method: "POST",
        credentials: "same-origin",
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json",
        },
        body: JSON.stringify({ message: text, history }),
      });

      let data;
      const raw = await res.text();
      try {
        data = raw ? JSON.parse(raw) : {};
      } catch {
        data = { ok: false, error: raw?.slice(0, 200) || `HTTP ${res.status}` };
      }

      if (!res.ok || !data?.ok) {
        setMessages((prev) => [
          ...prev,
          {
            role: "assistant",
            text:
              data?.error ||
              `Request failed (${res.status}). Check GOOGLE_API_KEY and server logs.`,
            error: true,
          },
        ]);
        return;
      }

      if (data.catalogFilters && onApplyCatalogFilters) {
        onApplyCatalogFilters(data.catalogFilters);
      }

      setMessages((prev) => [
        ...prev,
        {
          role: "assistant",
          text: data.reply || "(Empty response)",
          toolsUsed: data.toolsUsed,
          filtersApplied: Boolean(data.catalogFilters),
          filterSummary: data.filterSummary || null,
        },
      ]);
    } catch (err) {
      setMessages((prev) => [
        ...prev,
        {
          role: "assistant",
          text: `Network error: ${err?.message || "try again"}`,
          error: true,
        },
      ]);
    } finally {
      setLoading(false);
    }
  }, [input, loading, messages, onApplyCatalogFilters]);

  return (
    <>
      <div className="curator-chat-fab">
        <button
          type="button"
          className="curator-chat-fab__btn"
          onClick={() => setOpen((v) => !v)}
          aria-expanded={open}
          aria-controls="curator-chat-panel"
        >
          {open ? "Close chat" : "AI Curator"}
        </button>
      </div>

      {open && (
        <div
          id="curator-chat-panel"
          className="curator-chat-panel"
          role="dialog"
          aria-label="AI Curator Chat"
        >
          <header className="curator-chat-panel__header">
            <div>
              <strong>AI Curator Chat</strong>
              <p>Gemini · Alterpop catalog</p>
            </div>
            <button
              type="button"
              className="curator-chat-panel__close"
              onClick={() => setOpen(false)}
              aria-label="Close"
            >
              ×
            </button>
          </header>

          <div ref={scrollRef} className="curator-chat-panel__messages">
            {messages.map((msg, i) => (
              <div
                key={`${i}-${msg.role}-${msg.text.slice(0, 12)}`}
                className={`curator-chat-bubble curator-chat-bubble--${msg.role}${
                  msg.error ? " curator-chat-bubble--error" : ""
                }`}
              >
                <div className="curator-chat-bubble__text">{msg.text}</div>
                {msg.filtersApplied && (
                  <div className="curator-chat-bubble__tools">
                    {msg.filterSummary
                      ? `Panel: ${msg.filterSummary}`
                      : "Filters applied to the catalog panel →"}
                  </div>
                )}
                {msg.toolsUsed?.length > 0 && !msg.filtersApplied && (
                  <div className="curator-chat-bubble__tools">
                    {`Tools: ${msg.toolsUsed.join(", ")}`}
                  </div>
                )}
              </div>
            ))}
            {loading && (
              <div className="curator-chat-bubble curator-chat-bubble--assistant">
                <Spinner size="small" accessibilityLabel="Thinking" />
                <span style={{ marginLeft: 8 }}>Thinking…</span>
              </div>
            )}
          </div>

          <footer className="curator-chat-panel__footer">
            <TextField
              label="Message"
              labelHidden
              value={input}
              onChange={setInput}
              placeholder="e.g. Show Funko figures with stock"
              autoComplete="off"
              multiline={2}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey) {
                  e.preventDefault();
                  sendMessage();
                }
              }}
              disabled={loading}
            />
            <button
              type="button"
              className="curator-chat-panel__send"
              onClick={sendMessage}
              disabled={loading || !input.trim()}
            >
              {loading ? "Sending…" : "Send"}
            </button>
          </footer>
        </div>
      )}
    </>
  );
}
