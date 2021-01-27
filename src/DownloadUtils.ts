
import ArrayBufferSlice from "./ArrayBufferSlice";

function downloadHref(filename: string, href: string): void {
    const elem = document.createElement('a');
    elem.setAttribute('href', href);
    elem.setAttribute('download', filename);
    document.body.appendChild(elem);
    elem.click();
    document.body.removeChild(elem);
}

export function downloadBlob(filename: string, blob: Blob): void {
    const url = window.URL.createObjectURL(blob);
    downloadHref(filename, url);
    window.URL.revokeObjectURL(url);
}

export function downloadBufferSlice(filename: string, buffer: ArrayBufferSlice, type: string = 'application/octet-stream'): void {
    const blob = new Blob([buffer.createTypedArray(Uint8Array)], { type });
    downloadBlob(filename, blob);
}
export function downloadText(filename: string, str: string, type: string = 'application/text'): void {
    const blob = new Blob([str], { type });
    downloadBlob(filename, blob);
}

export function downloadBuffer(filename: string, buffer: ArrayBufferLike, type: string = 'application/octet-stream'): void {
    buffer = buffer as ArrayBuffer;
    const blob = new Blob([buffer], { type });
    downloadBlob(filename, blob);
}

export function downloadCanvasAsPng(canvas: HTMLCanvasElement, filename: string = 'canvas.png'): void {
    let downloadLink = document.createElement('a');
    downloadLink.setAttribute('download', filename);
    canvas.toBlob(function (blob: (Blob | null)) {
        if (blob) {
            let url = URL.createObjectURL(blob);
            downloadLink.setAttribute('href', url);
            downloadLink.click();
        }
    });
}
