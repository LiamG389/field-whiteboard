# Field — infinite local whiteboard

The creation of this app was assisted by ChatGPT.
Plain HTML, CSS, and browser JavaScript, with a Node.js LAN server. PDFKit and PptxGenJS generate downloadable documents locally; the browser has no framework or remote dependencies.

## Run

Requires Node.js 20 or newer. From this directory:

```sh
npm install
npm start
```

Open http://localhost:53318. Choose **Share board**, then open the link on another device on the same Wi-Fi/LAN. All participants must use the same board link. Only the host needs Node.js. Allow incoming connections if your firewall asks; guest Wi-Fi/client isolation can prevent devices from connecting. Keep the server running while collaborating.

The Share dialog also shows a **QR code**. Scan it with the phone/tablet camera to join without typing. QR generation happens entirely on your local server. When the host has multiple network addresses (for example, Wi-Fi and a VPN), choose the Wi-Fi address in the dialog; both the link and QR update together.

To stop the app, press **Ctrl+C** in the terminal running `npm start`. Start it again with the same command. Saved boards remain in `data/`; keep their links to reopen them. Closing a browser tab does not stop the server.

`PORT=8080 npm start` changes the HTTP port. `DISCOVERY=0 npm start` disables multicast. `DATA_DIR=/path/to/boards npm start` changes where boards are stored.

## Tools

- Compact mode: toggle **Compact** in the lower-right corner. Use the adjacent gear to choose whether to hide the header, page navigation, pen palette, bottom controls, and hints. By default, the palette stays visible; click the arrow to reveal the controls, then **<** to tuck them away again. Toggle Compact off to restore the normal layout. The preference is remembered on this browser and works at any screen size.
- New board: opens a fresh board with its own sharing link in a new tab, keeping the current board open.
- Pages: use **+** above the canvas to add an infinite page to the same document. The **‹ / ›** controls or **Left / Right arrow keys** move between pages. **☰** opens the page list: click a number to jump, or edit a page name. Entering a page fits and centers its content once, including pages selected by Follow. This does not enable continuous Auto-fit or stop an active Follow session. Each device chooses its own page; adding/renaming pages and editing their contents syncs to everyone. Documents support up to 100 pages.
- Images: click **▧** in the palette to insert a PNG, JPEG, GIF, or WebP. Use **↖ Select** to move images or text; click an image to resize it proportionally or delete it. Images sync, support undo, and are included in every export. Large images are resized for sharing; animated images become still images.
- Page background: open **☰** and choose a background color for the current page. Colors sync and are saved in exports.
- PowerPoint import: choose **Import PPTX** in the download dialog. Slides are appended as pages with editable text, embedded images, basic shapes, and background colors. Import can be undone. Fonts and wrapping may differ; charts, SmartArt, animations, and advanced styling are not fully supported. The import report lists limitations. Processing stays on the local server.
- Pen (P): pressure-sensitive ink with selectable colors and sizes.
- Remove a page using **Remove** in the **☰** page menu. Removal syncs to everyone. Undo restores the page in its original position, including ink and text; the last remaining page cannot be removed.
- Text (T): click/tap the canvas to add a text box. Set text color, background color (or transparent), font size, and box width. Use line breaks for paragraphs. In Text mode, click a box to edit it or drag it to move. Save commits the change to other devices. Text creation, editing, moving, deletion, and erasing support undo/redo.
- Text wraps at word boundaries; only words wider than the entire box are split. In the text editor, select words and press **B** / **I** (or Cmd/Ctrl+B / Cmd/Ctrl+I) to toggle bold/italic. The preview shows the formatting. Styles sync and are retained by all export formats, including editable `.field.json` files.
- Eraser (E): remove whole strokes; drag to erase several.
- Hand (H), Space + drag, or middle mouse: pan. Fingers pan only in Hand mode, keeping palm rejection intact while writing.
- Scroll: zoom around the pointer. F fits all ink; click the percentage to reset zoom.
- Cmd/Ctrl Z and Cmd/Ctrl Shift Z: undo/redo this tab's changes.
- Download: export **all pages** as `.field.json`, `.pptx`, or `.pdf`. Each infinite page is fitted to a 16:9 slide/page with margins, including all ink and text outside the viewport. PowerPoint and PDF contain 1920×1080 page images, preserving text appearance but not individual editable objects. Use `.field.json` to retain editable text and ink. PDF/PowerPoint require the updated local server to be running.
- PNG and SVG downloads contain the **current page**, including text boxes. PNG output is scaled to at most 4096 pixels per side and 12 megapixels; SVG and board files preserve full coordinates.
- Open a saved document from the download dialog to append its pages. Old version-1 single-board files add their ink to the current page. Imported objects get fresh IDs, and the entire import can be undone. Files up to 25 MB, 100 total pages, and 10,000 imported objects are accepted. Existing saved boards automatically load as Page 1; no manual migration is needed.
- Auto-fit: toggle beside the zoom controls on each device that should follow all writing. This preference is saved per board on that browser. The view pans and zooms out to include shared live strokes, with room for the toolbars. It waits for your own pen to lift before adjusting your view. Manual pan or zoom turns auto-fit off. It never automatically zooms below 42.5%; when fitting would require a smaller scale, it leaves your current view in place until the content fits again. It zooms back in as content is erased or you switch to a smaller page. Fit uses the largest fitting scale, up to 800%.
- Auto-follow: click **Follow** beside the page controls, choose a connected person, and click **Start following**. Set your display name in the same dialog so others can recognize you. Pointer following prefers smoothly zooming out to include all current-page content and the writer. Once content would become too small (roughly 62.5% zoom for handwriting, adjusted for text size), it keeps a readable scale and pans near the writer instead. It smoothly zooms back in when content can fit at a larger size, up to 800%. Choose **Pointer only** to track the pointer on your current page, **Slide number only** to switch pages without panning, or **Both** to switch pages and track the pointer. Pointer movement and page changes are shared even when the person is not drawing. It pauses while you draw; manual pan, zoom, Fit, or page navigation stops following. Auto-fit can be combined with Slide number only following to fit each selected page. Pointer following and Auto-fit are mutually exclusive. Enable **Follow their zoom** to match the selected device’s exact zoom (including zoom changes without drawing). This overrides automatic follow framing and Auto-fit, and works with pointer, page, or combined following. When someone follows you, a **Focus** button appears in the corner: press it, then tap the canvas to smoothly move every follower to that point at your current zoom. **Re-Zoom** beside it sends a one-time smooth zoom adjustment while preserving each follower’s current center point. It appears only if every follower is not already using Follow their zoom. Neither command changes follow settings. If the selected person disconnects, following waits for them to reconnect or for you to select someone else.

`public/vocab-pen.js` contains the original `StrokeCanvas` class copied **word for word** from `vocab.html`. Its original down/move/up and touch handlers are used unchanged. A separate adapter in `app.js` translates infinite-canvas coordinates and connects color, width, document storage, and live sync. The later stream-handoff and hover-recovery changes have been removed from pen handling. A regression test compares the full copied class against the original source. Actual Pencil behavior should still be checked on the target iPad.

## Sync and LocalSend

LocalSend is a file-transfer protocol, not a collaborative editing protocol. Its documented approach is UDP multicast discovery and direct HTTP(S) transfers without cloud servers: https://github.com/localsend/protocol.

This app uses the **same networking approach**, not wire compatibility with LocalSend: UDP multicast at `224.0.0.167:53318` discovers other Field hosts, HTTP POST sends edits directly to the host, and Server-Sent Events streams edits and in-progress strokes to its browsers. Discovery uses a separate application marker and port so it does not masquerade as a LocalSend device. Browsers cannot bind raw UDP sockets or listen as HTTP servers, so the small Node process provides those capabilities. Discovering a host does not reveal private board links; share the exact board link to collaborate.

The host orders edits, deduplicates retries, and saves each committed edit atomically under `data/`. Browsers store board backups and disconnected edits asynchronously in IndexedDB (the previous localStorage backup is removed only after successful migration). Imports upload one slide at a time. Receiving devices acknowledge imported objects and each slide of a reconnect snapshot before the next is sent, keeping large presentations from overwhelming slower tablets. Browsers queue disconnected edits locally, then replay them after receiving the current snapshot on reconnect. Undo records only local actions; erasing or restoring a shared object still changes that object for everyone. Live ink previews are transient and expire after disconnection. Board IDs are random 128-bit link secrets. There are no cloud calls; PDF and PowerPoint processing stays on the LAN host.

This version uses unencrypted HTTP on a trusted LAN (LocalSend also permits HTTP). Anyone with the board link can edit. It is not intended to be exposed to the public internet. A single host coordinates each board; automatic multi-host replication and LocalSend file exchange are not implemented. Very large boards are limited by device memory and local storage; export important drawings.

## Check

```sh
npm test
```

Tests exercise live event fan-out, concurrent edits, retry deduplication, exact original pen-source equality, original stylus behavior, text editing/moving, page isolation and navigation, import undo/redo, legacy documents, export file structure/page counts, QR decoding to the join URL, participant presence/naming, selected-writer following, validation, and persistence across server restarts.
