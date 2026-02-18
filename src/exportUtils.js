import { jsPDF } from "jspdf";
import { svg2pdf } from "svg2pdf.js"; // also augments jsPDF.API.svg as side effect
import html2canvas from "html2canvas";

/**
 * Download high-quality SVG from rendered diagram.
 * Adds proper XML headers, viewBox, and CSS for crisp output.
 */
export function downloadSvgHQ(svgString, filename = "diagram.svg") {
  // Ensure proper XML declaration and viewBox
  let svg = svgString;
  if (!svg.includes("<?xml")) {
    svg = '<?xml version="1.0" encoding="UTF-8"?>\n' + svg;
  }
  // Add xmlns if missing
  if (!svg.includes('xmlns="http://www.w3.org/2000/svg"')) {
    svg = svg.replace("<svg", '<svg xmlns="http://www.w3.org/2000/svg"');
  }

  const blob = new Blob([svg], { type: "image/svg+xml;charset=utf-8" });
  triggerDownload(blob, filename);
}

/**
 * Download high-quality PNG at specified scale (default 3x for print quality).
 */
export async function downloadPngHQ(svgString, filename = "diagram.png", scale = 3) {
  const blob = new Blob([svgString], { type: "image/svg+xml;charset=utf-8" });
  const url = URL.createObjectURL(blob);

  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => {
      const w = (img.naturalWidth || img.width || 1600) * scale;
      const h = (img.naturalHeight || img.height || 900) * scale;

      const canvas = document.createElement("canvas");
      canvas.width = w;
      canvas.height = h;
      const ctx = canvas.getContext("2d");

      // White background
      ctx.fillStyle = "#ffffff";
      ctx.fillRect(0, 0, w, h);

      // Scale and draw
      ctx.scale(scale, scale);
      ctx.drawImage(img, 0, 0);

      canvas.toBlob(
        (pngBlob) => {
          if (!pngBlob) {
            reject(new Error("PNG conversion failed"));
            return;
          }
          triggerDownload(pngBlob, filename);
          URL.revokeObjectURL(url);
          resolve();
        },
        "image/png",
        1.0
      );
    };
    img.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error("Failed to load SVG for PNG conversion"));
    };
    img.src = url;
  });
}

/**
 * Download PDF from SVG.
 * Uses svg2pdf.js for vector quality when possible.
 * Falls back to html2canvas rasterization for complex SVGs with foreignObject.
 */
export async function downloadPdf(svgString, filename = "diagram.pdf") {
  // Try vector PDF first via svg2pdf.js
  try {
    const result = await vectorPdf(svgString, filename);
    if (result) return;
  } catch {
    // Fall through to raster
  }

  // Fallback: raster PDF via html2canvas
  await rasterPdf(svgString, filename);
}

/**
 * Vector PDF using svg2pdf.js — best quality, selectable text.
 * Will fail if SVG contains <foreignObject> (Mermaid's htmlLabels).
 */
async function vectorPdf(svgString, filename) {
  // Parse the SVG into a DOM element
  const parser = new DOMParser();
  const svgDoc = parser.parseFromString(svgString, "image/svg+xml");
  const svgEl = svgDoc.documentElement;

  if (!(svgEl instanceof SVGSVGElement)) return false;

  // Check for foreignObject — svg2pdf.js can't handle these
  if (svgEl.querySelector("foreignObject")) {
    throw new Error("SVG contains foreignObject, falling back to raster");
  }

  const vb = svgEl.viewBox?.baseVal;
  const width = vb?.width || parseFloat(svgEl.getAttribute("width")) || 800;
  const height = vb?.height || parseFloat(svgEl.getAttribute("height")) || 600;

  // Add some padding
  const pad = 20;
  const pdfW = width + pad * 2;
  const pdfH = height + pad * 2;

  const orientation = pdfW > pdfH ? "landscape" : "portrait";
  const pdf = new jsPDF({
    orientation,
    unit: "pt",
    format: [pdfW, pdfH],
  });

  // Temporarily attach SVG to DOM for measurement (svg2pdf needs this)
  const container = document.createElement("div");
  container.style.position = "absolute";
  container.style.left = "-9999px";
  container.appendChild(svgEl);
  document.body.appendChild(container);

  try {
    if (typeof pdf.svg === "function") {
      // Use jsPDF.API.svg (augmented by svg2pdf.js side-effect import)
      await pdf.svg(svgEl, { x: pad, y: pad, width, height });
    } else {
      // Fallback: use the explicit svg2pdf function
      await svg2pdf(svgEl, pdf, { x: pad, y: pad, width, height });
    }
    pdf.save(filename);
    return true;
  } finally {
    document.body.removeChild(container);
  }
}

/**
 * Raster PDF using html2canvas — handles all SVG features including foreignObject.
 * Output is rasterized at 3x for print quality.
 */
async function rasterPdf(svgString, filename) {
  // Create a temporary container with the SVG
  const container = document.createElement("div");
  container.style.position = "absolute";
  container.style.left = "-9999px";
  container.style.background = "#ffffff";
  container.style.padding = "20px";
  container.innerHTML = svgString;
  document.body.appendChild(container);

  try {
    const canvas = await html2canvas(container, {
      scale: 3,
      useCORS: true,
      backgroundColor: "#ffffff",
      logging: false,
    });

    const imgData = canvas.toDataURL("image/png", 1.0);
    const pdfW = canvas.width / 3; // back to original size in pts
    const pdfH = canvas.height / 3;

    const orientation = pdfW > pdfH ? "landscape" : "portrait";
    const pdf = new jsPDF({
      orientation,
      unit: "px",
      format: [pdfW, pdfH],
    });

    pdf.addImage(imgData, "PNG", 0, 0, pdfW, pdfH);
    pdf.save(filename);
  } finally {
    document.body.removeChild(container);
  }
}

/**
 * Generate a PNG blob (for thumbnails, Firebase storage, etc.)
 */
export async function svgToPngBlob(svgString, scale = 2) {
  const blob = new Blob([svgString], { type: "image/svg+xml;charset=utf-8" });
  const url = URL.createObjectURL(blob);

  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => {
      const w = (img.naturalWidth || 800) * scale;
      const h = (img.naturalHeight || 600) * scale;
      const canvas = document.createElement("canvas");
      canvas.width = w;
      canvas.height = h;
      const ctx = canvas.getContext("2d");
      ctx.fillStyle = "#ffffff";
      ctx.fillRect(0, 0, w, h);
      ctx.scale(scale, scale);
      ctx.drawImage(img, 0, 0);
      canvas.toBlob(
        (b) => {
          URL.revokeObjectURL(url);
          resolve(b);
        },
        "image/png",
        0.9
      );
    };
    img.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error("SVG to PNG failed"));
    };
    img.src = url;
  });
}

function triggerDownload(blob, filename) {
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  link.click();
  URL.revokeObjectURL(url);
}

/**
 * Download PNG directly from a data URL (for custom-rendered diagrams captured via html2canvas).
 */
export function downloadPngFromDataUrl(dataUrl, filename = "diagram.png") {
  const [meta, base64] = dataUrl.split(",");
  const mime = meta.match(/:(.*?);/)[1];
  const binary = atob(base64);
  const arr = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) arr[i] = binary.charCodeAt(i);
  const blob = new Blob([arr], { type: mime });
  triggerDownload(blob, filename);
}

/**
 * Download PDF from a PNG data URL (for custom-rendered diagrams captured via html2canvas).
 */
export function downloadPdfFromDataUrl(dataUrl, width, height, filename = "diagram.pdf") {
  const scale = 3;
  const pdfW = width / scale;
  const pdfH = height / scale;
  const orientation = pdfW > pdfH ? "landscape" : "portrait";
  const pdf = new jsPDF({ orientation, unit: "px", format: [pdfW, pdfH] });
  pdf.addImage(dataUrl, "PNG", 0, 0, pdfW, pdfH);
  pdf.save(filename);
}
