# 80hdkb Library: setup

Three parts, about 15 minutes total, done once.

## 1. Connect the Google Sheet (computer, about 5 minutes)

1. Open the **Home Library Data Pull** Google Sheet.
2. Go to **Extensions → Apps Script**.
3. Leave your existing code alone (your `OPENLIB_` lookup functions live there). Click **+** next to Files, choose **Script**, and name it `LibraryApp`. Paste in the contents of [`sheet-sync/Code.gs`](sheet-sync/Code.gs) from this repository and click **Save**.
   - If your existing code already has a function called `onOpen`, tell Claude and it'll merge the two.
4. Go back to the sheet and reload the page. A new **Library App** menu appears.
5. Choose **Library App → 1. Set up app tabs**. Google will ask you to authorize the script; approve it.
   - This adds two tabs, **App Catalogue** and **App Rooms**, and copies your books into them. Your existing tabs are not changed.
6. Back in Apps Script, click **Deploy → New deployment**.
   - Click the gear next to "Select type" and choose **Web app**.
   - **Execute as:** Me
   - **Who has access:** Anyone
   - Click **Deploy**, and approve again if asked.
   - Copy the **Web app URL** it shows (it ends in `/exec`).
7. In the sheet, choose **Library App → 2. Email me the connection code**, and paste that URL when asked. You only paste it once.

"Anyone" sounds alarming but the app also needs the secret connection code, so nobody can read or change your catalogue without it. Keep that email private.

## 2. Install the app (each phone and the Boox)

1. On the device, open **github.com/dkbrandi/80hdkb-library/releases/latest** and sign in to GitHub if asked.
2. Tap **80hdkb-library.apk** to download it.
3. Open the download. Android will ask to allow installs from your browser: tap **Settings**, turn on **Allow from this source**, go back, and tap **Install**.
4. If Play Protect warns that it doesn't recognize the developer, tap **More details → Install anyway**. It's flagging that the app didn't come from the Play Store, which is expected.

Updates: install a newer APK the same way. It installs over the old version and keeps your data.

## 3. Connect each device

1. Open **80hdkb Library**.
2. Open the connection code email on that device, copy the line that starts with `BLIB1:`, and paste it into the app.
3. Tap **Connect and download**. Your catalogue arrives in a few seconds.
4. On the Boox: tap the gear, then **E-ink mode**.

## How sync works

- Every device keeps a full copy, so the app works with no signal. Changes sync when you're back online.
- Edits sync a few seconds after you make them, and again whenever you open the app. Tap the sync status under the title to sync right away.
- If two devices change the same book, the most recent change wins.
- Cover photos are saved in a Google Drive folder called **Brandi Library Covers**.
- You can edit the **App Catalogue** tab directly in Sheets too. Changes there reach the app on its next sync.
