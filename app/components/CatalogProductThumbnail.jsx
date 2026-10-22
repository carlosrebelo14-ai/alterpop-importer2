/* eslint-disable react/prop-types */
import { useState, useEffect } from "react";
import { createPortal } from "react-dom";
import { ImagePlaceholderIcon } from "./InlineSvgIcon.jsx";
import {
  resolveAllProductImages,
  resolveProductImageSource,
  urlDaImagemDoCatalogo,
} from "../../lib/catalog/productImages.js";

// Reexporta com os mesmos nomes, para quem os importa daqui continuar a funcionar.
export { resolveAllProductImages, resolveProductImageSource };

/**
 * Miniatura para ResourceList — img nativo com galeria de imagens e lightbox.
 * A imagem vem sempre da rota da app, por SKU e índice. O URL do fornecedor não chega ao browser.
 * @param {{ sku?: string, imageUrl?: string | string[] | null, title?: string, size?: number }} props
 */
/** Tentativas a mais depois de um erro. Com a primeira, são três pedidos no total. */
const TENTATIVAS_EXTRA = 2;
/** Pausa antes de cada tentativa. É o Retry-After de 5 s que a rota devolve com o 503. */
const PAUSA_MS = 5000;

export function CatalogProductThumbnail({ sku, imageUrl, title = "", size = 50 }) {
  // esgotado: acabaram as tentativas. aguarda: está na pausa antes da próxima tentativa.
  const [esgotado, setEsgotado] = useState(false);
  const [aguarda, setAguarda] = useState(false);
  const [tentativas, setTentativas] = useState(0);
  const [hovered, setHovered] = useState(false);
  const [isOpen, setIsOpen] = useState(false);
  const [activeIdx, setActiveIdx] = useState(0);
  const failed = esgotado || aguarda;

  // O imageUrl só conta as imagens. Nunca é usado como src.
  // É a mesma lista que o servidor usa. Assim o índice e o ?v= batem nos dois lados.
  const images = resolveAllProductImages(imageUrl);
  const primeiraImagem = images[0];
  // A lista pode encolher com o modal aberto. O índice tem de ficar dentro dela, senão não há URL para a imagem.
  const idxAtivo = activeIdx < images.length ? activeIdx : 0;

  useEffect(() => {
    if (!isOpen) return;
    const handleKeyDown = (e) => {
      if (e.key === "Escape") setIsOpen(false);
      if (e.key === "ArrowLeft") {
        setActiveIdx((prev) => (prev > 0 ? prev - 1 : images.length - 1));
      }
      if (e.key === "ArrowRight") {
        setActiveIdx((prev) => (prev < images.length - 1 ? prev + 1 : 0));
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [isOpen, images.length]);

  // Com o modal aberto, a lista pode encolher. O índice volta para dentro dela, senão a primeira seta não mudava a foto.
  useEffect(() => {
    if (activeIdx !== idxAtivo) setActiveIdx(idxAtivo);
  }, [activeIdx, idxAtivo]);

  // Outro SKU ou outra primeira imagem: a falha anterior não se aplica, e a miniatura começa de novo.
  useEffect(() => {
    setAguarda(false);
    setEsgotado(false);
    setTentativas(0);
  }, [sku, primeiraImagem]);

  // Pausa antes de pedir a imagem outra vez. Enquanto dura, a miniatura mostra o placeholder.
  useEffect(() => {
    if (!aguarda) return undefined;
    const temporizador = setTimeout(() => setAguarda(false), PAUSA_MS);
    return () => clearTimeout(temporizador);
  }, [aguarda]);

  // Sem imagens, sem SKU ou com erro de carregamento: placeholder.
  if (images.length === 0 || !sku || failed) {
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
              backgroundColor: "rgba(0, 0, 0, 0.78)",
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
                maxWidth: 720,
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
                  position: "relative",
                  width: "100%",
                  display: "flex",
                  justifyContent: "center",
                  alignItems: "center",
                  maxHeight: "65vh",
                  overflow: "hidden",
                }}
              >
                {images.length > 1 && (
                  <button
                    onClick={() => setActiveIdx((prev) => (prev > 0 ? prev - 1 : images.length - 1))}
                    style={{
                      position: "absolute",
                      left: 8,
                      background: "rgba(255,255,255,0.85)",
                      border: "1px solid #ccc",
                      borderRadius: "50%",
                      width: 40,
                      height: 40,
                      fontSize: 20,
                      cursor: "pointer",
                      display: "flex",
                      alignItems: "center",
                      justifyContent: "center",
                      boxShadow: "0 2px 8px rgba(0,0,0,0.15)",
                      zIndex: 5,
                    }}
                    title="Foto anterior (Seta esquerda)"
                  >
                    ‹
                  </button>
                )}

                <img
                  src={urlDaImagemDoCatalogo(sku, idxAtivo, images[idxAtivo])}
                  alt={title}
                  style={{
                    maxWidth: "100%",
                    maxHeight: "65vh",
                    objectFit: "contain",
                    borderRadius: 8,
                    display: "block",
                  }}
                />

                {images.length > 1 && (
                  <button
                    onClick={() => setActiveIdx((prev) => (prev < images.length - 1 ? prev + 1 : 0))}
                    style={{
                      position: "absolute",
                      right: 8,
                      background: "rgba(255,255,255,0.85)",
                      border: "1px solid #ccc",
                      borderRadius: "50%",
                      width: 40,
                      height: 40,
                      fontSize: 20,
                      cursor: "pointer",
                      display: "flex",
                      alignItems: "center",
                      justifyContent: "center",
                      boxShadow: "0 2px 8px rgba(0,0,0,0.15)",
                      zIndex: 5,
                    }}
                    title="Próxima foto (Seta direita)"
                  >
                    ›
                  </button>
                )}
              </div>

              {images.length > 1 && (
                <div style={{ display: "flex", gap: 6, marginTop: 12, overflowX: "auto", maxWidth: "100%", padding: "4px 0" }}>
                  {images.map((_, i) => (
                    <img
                      key={i}
                      src={urlDaImagemDoCatalogo(sku, i, images[i])}
                      alt=""
                      onClick={() => setActiveIdx(i)}
                      style={{
                        width: 44,
                        height: 44,
                        objectFit: "cover",
                        borderRadius: 6,
                        cursor: "pointer",
                        border: i === idxAtivo ? "2px solid #005bd3" : "1px solid #ddd",
                        opacity: i === idxAtivo ? 1 : 0.6,
                        transition: "all 0.15s ease",
                      }}
                    />
                  ))}
                </div>
              )}

              {title && (
                <div
                  style={{
                    marginTop: 14,
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
                  {images.length > 1 && (
                    <span style={{ display: "block", fontSize: 12, fontWeight: 400, color: "#6d7175", marginTop: 4 }}>
                      {`Foto ${idxAtivo + 1} de ${images.length}`}
                    </span>
                  )}
                </div>
              )}
            </div>
          </div>,
          document.body
        )
      : null;

  return (
    <div style={{ position: "relative", display: "inline-block", flexShrink: 0 }}>
      <img
        src={urlDaImagemDoCatalogo(sku, 0, images[0])}
        alt={title}
        width={size}
        height={size}
        loading="lazy"
        decoding="async"
        title={images.length > 1 ? `Galeria de ${images.length} fotos — Clicar para ver em grande` : "Clicar para ampliar imagem"}
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
        onClick={() => {
          setActiveIdx(0);
          setIsOpen(true);
        }}
        onError={() => {
          // O browser não volta a pedir uma imagem com erro. Um 503 do servidor (muitos pedidos ao mesmo tempo)
          // não é definitivo. Pede-se outra vez, depois da pausa, até acabarem as tentativas.
          if (tentativas >= TENTATIVAS_EXTRA) {
            setEsgotado(true);
            return;
          }
          setTentativas(tentativas + 1);
          setAguarda(true);
        }}
      />
      {images.length > 1 && (
        <span
          title={`${images.length} fotos disponíveis`}
          style={{
            position: "absolute",
            bottom: 2,
            right: 2,
            background: "rgba(0, 0, 0, 0.75)",
            color: "#ffffff",
            fontSize: 10,
            fontWeight: 700,
            padding: "1px 4px",
            borderRadius: 4,
            pointerEvents: "none",
            lineHeight: 1.2,
          }}
        >
          {`📷 ${images.length}`}
        </span>
      )}
      {modalNode}
    </div>
  );
}
