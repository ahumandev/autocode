# AutoChamber

Use the AutoChamber extension in OpenChamber:

1. **Get the folder.** Ask your distributor or OpenChamber administrator for a ready-to-install copy. If it comes as an archive, extract it and use the `autochamber` folder inside, not the archive.
2. **Install and approve.** In OpenChamber, open **Settings**, select **Extensions** under **General**, then select **Add extension**.
   - In **Folder, ZIP, or URL**, enter the full path to the `autochamber` folder containing `package.json`, then select **Add**. Use the path on the computer running OpenChamber.
   - On desktop, if you can access the folder locally, **Browse folder** installs AutoChamber as soon as you select the folder.
   - At **Allow AutoChamber?**, review **Service** and select **Approve** only if you trust the copy. Use **Review permissions** to revisit access later. Select **Enable** only if AutoChamber is disabled.
3. **Open AutoChamber.** Back in the workspace, click the **AutoChamber** icon in the right-side context rail beside chat, not in the sidebar. If the icon is missing, scroll the rail or open **Configure panels** and show **AutoChamber** or select **Show all**.
4. **Change AutoCode settings.** Select **Settings** inside the AutoChamber panel, not in OpenChamber's own settings.
   - In **Settings scope**, choose **global** for defaults across projects, **worktree** for the whole project, or **active** for the open folder, if listed. If the scope you need is missing or read-only, open the intended project or ask your administrator.
   - **Raw in selected scope** shows what's saved in that scope. **Effective** shows what the project uses after any overrides.
   - To stop automatic skill setup on first use, choose `true` for **autocode.skills.freeze** and select **Set autocode.skills.freeze**. To change where memory files are kept, enter a folder under **autocode.memory.directory** and select **Set autocode.memory.directory**. If a save conflicts with a newer change, select **Refresh**, then reapply the change.
5. **Save a connection.** In **Profiles**, select **Create REST profile**, **Create SSH profile**, or **Create DB profile**. Choose a storage provider and enter a **Profile ID** you'll recognize.
   - Set each field's **Action** to **Set** to enter a value. Leave unused fields on **Omit**.
     - **REST:** Enter **Authorization**, or both **Username** and **Password**.
     - **SSH:** Enter **Host**. If you enter a **Port**, use a number from 1 to 65535.
     - **DB:** Enter the database connection string in **Connection**.
   - Check **Confirm this profile write.** and select **Create**. If asked to consent to unencrypted storage, agree only if you intend to use plaintext. Use the same profile ID when a tool asks for it.
   - AutoChamber doesn't show saved secret values. When editing, use **Keep** to leave a secret unchanged, **Set** to replace it, or **Clear** to remove it. Confirm the write and select **Update**.

See [credential profile fields and sign-in options](credentials.md#fields-and-auth) for help with the other fields.

**Where secrets are stored:** On Windows, the default saves to Windows Credential Manager and requires the expected Windows account. AutoChamber can read from Linux Secret Service but can't save to it. If your store is unavailable, ask your administrator. A failed save won't switch to plaintext. Choose plaintext only if you accept that it stores secrets unencrypted on disk.

**Use a trusted local host.** Service approval lets AutoChamber run on that computer; it doesn't isolate it. This guide doesn't cover remote access.
