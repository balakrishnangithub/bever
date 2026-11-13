# Security policy

Bever handles private notes, attachments, and cloud access tokens. Please do not disclose a suspected vulnerability in a public issue or attach private note exports to a report.

Report it privately through the repository's **Security** tab (**Report a vulnerability**). If that option is not offered, open an issue that only asks for a private contact, without any detail of the problem. In the report, include the affected version, reproduction steps, impact, and a minimal synthetic example. Remove all personal note content and credentials.

## How notes are contained

Notes are untrusted input: they come from imported files and from other devices.

- Scripts in notes do not run. The content security policy allows no inline or remote script, and the editor keeps only the elements and attributes it knows.
- The part of the application that displays notes cannot name a file to read or write. Files are chosen in system dialogs opened by the native side.
- Importing from the Evernote application reads the folder in which Evernote keeps an account, which the native side finds by itself; the interface chooses only among the notebooks found there. The files are opened for reading only, and what Evernote keeps for signing in is not looked at.
- Links open only `http`, `https`, `mailto`, and `tel` addresses, in the system's own applications.
- Attachments are served to the interface by content hash only, with headers that prevent them from being executed.
- Images hosted on other websites are not requested unless you ask. Requesting one tells that website your network address and that the note was opened.
- A web clipping is shown with the layout of the page it came from. Its markup is rebuilt from known elements and attributes before it is drawn, without scripts, forms, or embedded pages, and it is drawn in a sandboxed frame.

## Credential safety

- pCloud access tokens are kept in the operating system credential vault, and are sent only to pCloud's API hosts, in a request header.
- **Disconnect** removes the token from the vault. So do **Remove all data from this device** and, on Windows, the `setup.exe` uninstaller when **Delete the application data** is ticked. The MSI uninstaller leaves it.
- Client secrets are not needed for the implicit-grant client flow and must not be embedded in the app.
- Never commit `.env` files, ENEX files, application databases, token dumps, or the ignored `reference/` and `test-data/` directories.
- Logs, error messages, and bug reports must not contain access tokens or full note contents.

## Data-protection expectations

Local notes are stored in the current user's application-data directory, not in an application-managed encrypted vault. Device disk encryption and OS account security remain important. pCloud transport uses HTTPS, but the remote Bever copy is not end-to-end encrypted. Evernote encrypted blocks are retained but not decrypted by Bever.

The Windows installers and the Android debug APK attached to releases are not code-signed. Verify a download against the `SHA256SUMS.txt` of its release.
