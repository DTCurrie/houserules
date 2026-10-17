// Types for the exported launcher. It is a side-effect module with no exports, imported by
// the thin `houserules` package's bin. attw rejects an export subpath that resolves to
// JavaScript with no declaration, so this file exists for that check alone.
export {};
