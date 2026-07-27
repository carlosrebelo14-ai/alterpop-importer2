/** Ícone inline (não depende do CSS Polaris). */
export function ImagePlaceholderIcon({ size = 20, title = "Imagem indisponível" }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 20 20"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      aria-hidden={title ? undefined : true}
      role={title ? "img" : undefined}
      aria-label={title || undefined}
    >
      <rect x="2" y="4" width="16" height="12" rx="2" stroke="#8c9196" strokeWidth="1.5" fill="#f1f1f1" />
      <circle cx="7" cy="9" r="1.5" fill="#8c9196" />
      <path d="M4 14l4-3 3 2 5-5" stroke="#8c9196" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}
