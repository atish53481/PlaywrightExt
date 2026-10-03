/** Hands `text` to the browser as a file download named `fileName`. */
export function saveTextFile(fileName: string, text: string): void {
  const url = URL.createObjectURL(new Blob([text], { type: 'text/plain;charset=utf-8' }));
  const link = document.createElement('a');
  link.href = url;
  link.download = fileName;
  document.body.appendChild(link);
  link.click();
  link.remove();
  // Released a moment later: some browsers start the download after this function returns.
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
