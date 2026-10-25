const CONTROL = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/gu

export function cleanPaste(text: string): string {
  return text.replace(CONTROL, '')
}

export function guardPaste(target: HTMLElement, paste: (text: string) => void): () => void {
  function onPaste(event: ClipboardEvent): void {
    event.preventDefault()
    event.stopImmediatePropagation()
    const clean = cleanPaste(event.clipboardData?.getData('text/plain') ?? '')
    if (clean !== '') paste(clean)
  }
  target.addEventListener('paste', onPaste, true)
  return () => target.removeEventListener('paste', onPaste, true)
}
