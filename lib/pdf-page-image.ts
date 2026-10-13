// One page of a PDF as a PNG, for handing a scan to a person's own assistant to read
// (ocr_page, diligence_stage_read). Rendered on the server with unpdf and @napi-rs/canvas.

/** Largest image handed over in one tool result. */
export const MAX_PAGE_IMAGE_BYTES = 4 * 1024 * 1024

export async function renderPdfPage(bytes: Uint8Array, page: number): Promise<{ png: Buffer; numPages: number }> {
  const { getDocumentProxy, renderPageAsImage } = await import('unpdf')
  const pdf = await getDocumentProxy(new Uint8Array(bytes))
  if (!Number.isInteger(page) || page < 1 || page > pdf.numPages) throw new Error(`The PDF has ${pdf.numPages} pages; ask for 1 to ${pdf.numPages}.`)
  const png = await renderPageAsImage(pdf, page, { scale: 2, canvasImport: () => import('@napi-rs/canvas') })
  return { png: Buffer.from(png), numPages: pdf.numPages }
}
