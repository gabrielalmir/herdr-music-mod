Extract the Windows ZIP and run `.\Install-Music.ps1` in PowerShell from the
extracted folder. The installer works offline and preserves your Spotify
authorization. It uses `HERDR_APP_HOME`, then `XDG_CONFIG_HOME/herdr-app`,
then `~/.config/herdr-app`.

The installer adds **Music** to `avlye-layout`. If ClickUp is installed,
**Tasks** appears alongside **Music**. Both buttons open their panels on
the right. A running Herdr window on `main` switches automatically. From
another layout, run `herdr-app do layout.switch --name avlye-layout`. You can
also select the layout after opening Herdr.

To update, rerun the installer from the new package. It chooses the newest
shared layout available locally, backs up a managed layout before replacing
it, and leaves an edited layout in place with instructions for manual use.

In the Spotify Dashboard, register `http://127.0.0.1:8765/callback` as the exact
redirect URI. Select **Connect Spotify**, enter your Client ID, and authorize
in your browser. Paste the full final URL into the panel, even if the callback
page fails to load. Select **Copy unlock code**, save the code, then select
**Finish connecting**. To choose your own password, select **Use my own
password**. Start playback on a Spotify device to test the controls.
