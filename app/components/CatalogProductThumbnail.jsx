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
    <img
      src={source}
      alt={title}
      width={size}
      height={size}
      loading="lazy"
      decoding="async"
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
        transition: "transform 160ms ease, box-shadow 160ms ease",
        transform: hovered ? "scale(1.04)" : "scale(1)",
        boxShadow: hovered ? "0 8px 18px rgba(0,0,0,0.12)" : "none",
      }}
      referrerPolicy="no-referrer"
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      onError={() => setFailed(true)}
    />
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
