/** Attachment addresses of the browser demonstration, which has no native store. */
const urls = new Map<string, string>([['demo-pdf', '/demo-attachments/demo-pdf']]);

export function registerDemoResource(reference: string, url: string) {
  urls.set(reference, url);
}

export function demoResourceUrl(reference: string): string {
  return urls.get(reference) ?? '';
}
