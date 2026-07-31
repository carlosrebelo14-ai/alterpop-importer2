/* eslint-disable react/prop-types */
import { useState, useEffect } from "react";
import { createPortal } from "react-dom";
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

  useEffect(() => {
    if (!isOpen) return;
    const handleKeyDown = (e) => {
      if (e.key === "Escape") setIsOpen(false);
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [isOpen]);

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

  const modalNode =
    isOpen && typeof document !== "undefined"
      ? createPortal(
          <div
            onClick={() => setIsOpen(false)}
            style={{
              position: "fixed",
              top: 0,
              left: 0,
              right: 0,
              bottom: 0,
              width: "100vw",
              height: "100vh",
              backgroundColor: "rgba(0, 0, 0, 0.75)",
              backdropFilter: "blur(6px)",
              zIndex: 9999999,
              display: "flex",
              flexDirection: "column",
              alignItems: "center",
              justifyContent: "center",
              padding: 20,
              boxSizing: "border-box",
            }}
          >
            <div
              onClick={(e) => e.stopPropagation()}
              style={{
                position: "relative",
                width: "100%",
                maxWidth: 680,
                maxHeight: "90vh",
                display: "flex",
                flexDirection: "column",
                alignItems: "center",
                background: "#ffffff",
                borderRadius: 16,
                padding: "24px 20px 20px 20px",
                boxShadow: "0 24px 60px rgba(0, 0, 0, 0.35)",
                border: "1px solid #e3e3e3",
                boxSizing: "border-box",
                overflow: "hidden",
              }}
            >
              <button
                onClick={() => setIsOpen(false)}
                style={{
                  position: "absolute",
                  top: 12,
                  right: 12,
                  background: "#f1f2f3",
                  border: "none",
                  color: "#202223",
                  fontSize: 18,
                  fontWeight: "bold",
                  width: 34,
                  height: 34,
                  borderRadius: "50%",
                  cursor: "pointer",
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                  zIndex: 10,
                  transition: "all 0.15s ease",
                }}
                onMouseEnter={(e) => {
                  e.currentTarget.style.background = "#e3e3e3";
                  e.currentTarget.style.transform = "scale(1.08)";
                }}
                onMouseLeave={(e) => {
                  e.currentTarget.style.background = "#f1f2f3";
                  e.currentTarget.style.transform = "scale(1)";
                }}
                title="Fechar (Esc)"
              >
                ✕
              </button>

              <div
                style={{
                  width: "100%",
                  display: "flex",
                  justifyContent: "center",
                  alignItems: "center",
                  maxHeight: "68vh",
                  overflow: "hidden",
                }}
              >
                <img
                  src={source}
                  alt={title}
                  style={{
                    maxWidth: "100%",
                    maxHeight: "68vh",
                    objectFit: "contain",
                    borderRadius: 8,
                    display: "block",
                  }}
                />
              </div>

              {title && (
                <div
                  style={{
                    marginTop: 16,
                    textAlign: "center",
                    color: "#202223",
                    fontSize: 14,
                    fontWeight: 600,
                    lineHeight: 1.4,
                    wordBreak: "break-word",
                    padding: "0 8px",
                  }}
                >
                  {title}
                </div>
              )}
            </div>
          </div>,
          document.body
        )
      : null;

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
      {modalNode}
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
