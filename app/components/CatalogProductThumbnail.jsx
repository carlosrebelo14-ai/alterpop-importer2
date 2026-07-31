/* eslint-disable react/prop-types */
import { useState } from "react";
import { ImagePlaceholderIcon } from "./InlineSvgIcon.jsx";

/**
 * Miniatura 50×50 para ResourceList — img nativo (evita Thumbnail Polaris sem CSS).
 * @param {{ imageUrl?: string | null, title?: string, size?: number }} props
 */
export function CatalogProductThumbnail({ imageUrl, title = "", size = 50 }) {
  const [failed, setFailed] = useState(false);
  const [hovered, setHovered] = useState(false);
  const [isOpen, setIsOpen] = useState(false);
  const source = resolveProductImageSource(imageUrl);

  if (!source || failed) {
    return (
      <div
        style={{
          width: size,
          height: size,
          flexShrink: 0,
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          borderRadius: "var(--p-border-radius-200, 8px)",
          background: "var(--p-color-bg-surface-secondary, #f1f1f1)",
          border: "1px solid var(--p-color-border-secondary, #e3e3e3)",
        }}
        aria-label="Imagem indisponível"
        title="Imagem indisponível"
      >
        <ImagePlaceholderIcon size={20} />
      </div>
    );
  }

  return (
    <>
      <img
        src={source}
        alt={title}
        width={size}
        height={size}
        loading="lazy"
        decoding="async"
        title="Clicar para ampliar imagem em grande"
        style={{
          width: size,
          height: size,
          minWidth: size,
          minHeight: size,
          maxWidth: size,
          maxHeight: size,
          objectFit: "cover",
          borderRadius: "var(--p-border-radius-200, 8px)",
          border: "1px solid var(--p-color-border-secondary, #e3e3e3)",
          display: "block",
          flexShrink: 0,
          cursor: "zoom-in",
          transition: "transform 180ms ease, box-shadow 180ms ease",
          transform: hovered ? "scale(1.08)" : "scale(1)",
          boxShadow: hovered ? "0 8px 20px rgba(0,0,0,0.18)" : "none",
        }}
        referrerPolicy="no-referrer"
        onMouseEnter={() => setHovered(true)}
        onMouseLeave={() => setHovered(false)}
        onClick={() => setIsOpen(true)}
        onError={() => setFailed(true)}
      />

      {isOpen && (
        <div
          onClick={() => setIsOpen(false)}
          style={{
            position: "fixed",
            top: 0,
            left: 0,
            width: "100vw",
            height: "100vh",
            backgroundColor: "rgba(15, 17, 26, 0.85)",
            backdropFilter: "blur(8px)",
            zIndex: 999999,
            display: "flex",
            flexDirection: "column",
            alignItems: "center",
            justifyContent: "center",
            padding: 24,
            cursor: "zoom-out",
          }}
        >
          <div
            onClick={(e) => e.stopPropagation()}
            style={{
              position: "relative",
              maxWidth: "90vw",
              maxHeight: "85vh",
              display: "flex",
              flexDirection: "column",
              alignItems: "center",
              background: "#181825",
              borderRadius: 16,
              padding: 20,
              boxShadow: "0 24px 48px rgba(0,0,0,0.6)",
              border: "1px solid rgba(255,255,255,0.12)",
              cursor: "default",
            }}
          >
            <button
              onClick={() => setIsOpen(false)}
              style={{
                position: "absolute",
                top: 12,
                right: 12,
                background: "rgba(255,255,255,0.15)",
                border: "none",
                color: "#fff",
                fontSize: 18,
                fontWeight: "bold",
                width: 32,
                height: 32,
                borderRadius: "50%",
                cursor: "pointer",
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                zIndex: 2,
                transition: "background 0.15s ease",
              }}
              onMouseEnter={(e) => (e.currentTarget.style.background = "rgba(255,255,255,0.3)")}
              onMouseLeave={(e) => (e.currentTarget.style.background = "rgba(255,255,255,0.15)")}
              title="Fechar (Esc)"
            >
              ✕
            </button>
            <img
              src={source}
              alt={title}
              style={{
                maxWidth: "100%",
                maxHeight: "72vh",
                objectFit: "contain",
                borderRadius: 8,
              }}
            />
            {title && (
              <div
                style={{
                  marginTop: 14,
                  textAlign: "center",
                  color: "#e2e8f0",
                  fontSize: 14,
                  fontWeight: 600,
                  maxWidth: 600,
                }}
              >
                {title}
              </div>
            )}
          </div>
        </div>
      )}
    </>
  );
}

/** @param {string | null | undefined} imageUrl */
export function resolveProductImageSource(imageUrl) {
  if (!imageUrl || typeof imageUrl !== "string") return null;
  const trimmed = imageUrl.trim();
  if (!trimmed) return null;
  if (/^https?:\/\//i.test(trimmed)) return trimmed;
  if (trimmed.startsWith("//")) return `https:${trimmed}`;
  return null;
}
