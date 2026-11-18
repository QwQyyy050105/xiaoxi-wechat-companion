using System;
using System.Diagnostics;
using System.Drawing;
using System.IO;
using System.Reflection;
using System.Threading.Tasks;
using System.Runtime.InteropServices;
using System.Security.Cryptography;
using System.Text;
using System.Windows.Forms;

internal static class Program
{
    internal const string ClientPath = ClientBinding.Path;
    private const string Publisher = "Tencent Technology (Shenzhen) Company Limited";

    [DllImport("user32.dll")]
    private static extern bool IsIconic(IntPtr window);
    [DllImport("user32.dll")]
    private static extern bool ShowWindowAsync(IntPtr window, int command);
    [DllImport("user32.dll")]
    private static extern bool SetForegroundWindow(IntPtr window);

    private static string LauncherMutexName()
    {
        // Only our own UI uses this mutex. No WeChat mutex is opened or changed.
        string ownPath = Path.GetFullPath(Assembly.GetExecutingAssembly().Location).ToUpperInvariant();
        using (SHA256 sha = SHA256.Create())
            return @"Local\LocalWeixinLauncher.UI." + BitConverter.ToString(
                sha.ComputeHash(Encoding.UTF8.GetBytes(ownPath))).Replace("-", "").Substring(0, 24);
    }

    private static void BringExistingLauncherToFront()
    {
        string ownPath = Path.GetFullPath(Assembly.GetExecutingAssembly().Location);
        using (Process current = Process.GetCurrentProcess())
        {
            foreach (Process process in Process.GetProcessesByName(current.ProcessName))
            {
                using (process)
                {
                    try
                    {
                        if (process.Id == current.Id || process.HasExited) continue;
                        process.Refresh();
                        IntPtr window = process.MainWindowHandle;
                        if (window == IntPtr.Zero || !String.Equals(process.MainModule.FileName,
                            ownPath, StringComparison.OrdinalIgnoreCase)) continue;
                        if (IsIconic(window)) ShowWindowAsync(window, 9); // SW_RESTORE, own launcher only.
                        SetForegroundWindow(window);
                        return;
                    }
                    catch (InvalidOperationException) { }
                    catch (System.ComponentModel.Win32Exception) { }
                }
            }
        }
    }

    // The caller holds a read-only file lease until Process.Start returns.
    // Read status and signer from the same Authenticode result, including timestamp validation.
    internal static string ValidateLockedClient(string path, out string version)
    {
        version = null;
        const string script =
            "$ErrorActionPreference='Stop'; try { " +
            "Import-Module (Join-Path $PSHOME 'Modules/Microsoft.PowerShell.Security/Microsoft.PowerShell.Security.psd1'); " +
            "$sig=Microsoft.PowerShell.Security\\Get-AuthenticodeSignature -LiteralPath $env:LOCAL_WEIXIN_VERIFY_FILE; " +
            "if ($sig.Status -ne 'Valid') {exit 21}; " +
            "if ($sig.SignerCertificate.GetNameInfo('SimpleName',$false) -cne '" + Publisher + "') {exit 22}; exit 0 " +
            "} catch {exit 23}";
        var info = new ProcessStartInfo(Path.Combine(Environment.SystemDirectory,
            @"WindowsPowerShell\v1.0\powershell.exe"), "-NoProfile -NonInteractive -NoLogo -EncodedCommand " +
            Convert.ToBase64String(Encoding.Unicode.GetBytes(script))) {
            UseShellExecute = false, CreateNoWindow = true, WorkingDirectory = Environment.SystemDirectory
        };
        info.EnvironmentVariables["LOCAL_WEIXIN_VERIFY_FILE"] = path;
        using (Process check = Process.Start(info))
        {
            if (!check.WaitForExit(20000))
            {
                if (!check.HasExited) check.Kill(); // Only the verification process created above.
                return "Windows 签名核验超时，请稍后重试。";
            }
            if (check.ExitCode == 21) return "Windows 未确认文件签名有效，请检查微信更新是否已完成。";
            if (check.ExitCode == 22) return "签名发布者与腾讯不匹配。";
            if (check.ExitCode != 0) return "无法取得 Windows 签名核验结果。";
        }
        var product = FileVersionInfo.GetVersionInfo(path);
        Version parsed;
        if (!String.Equals(product.ProductName, "Weixin", StringComparison.Ordinal) ||
            !String.Equals(product.FileDescription, "Weixin", StringComparison.Ordinal) ||
            !Version.TryParse(product.FileVersion, out parsed))
            return "签名文件的产品信息与官方微信不匹配。";
        version = parsed.ToString();
        return null;
    }

    internal static string CheckOrStart(bool launch, out string version)
    {
        version = null;
        if (!File.Exists(ClientPath)) return "未找到官方微信，请核对安装位置。";
        using (var lease = new FileStream(ClientPath, FileMode.Open, FileAccess.Read, FileShare.Read))
        {
            string error = ValidateLockedClient(ClientPath, out version);
            if (error != null || !launch) return error;
            using (Process client = Process.Start(new ProcessStartInfo(ClientPath) {
                UseShellExecute = false, WorkingDirectory = Path.GetDirectoryName(ClientPath)
            })) { }
        }
        return null;
    }

    internal sealed class ProcessSnapshot
    {
        internal int VisibleCount;
        internal int UnreadableCount;
    }

    internal static ProcessSnapshot VisibleProcesses()
    {
        ProcessSnapshot snapshot = new ProcessSnapshot();
        foreach (Process process in Process.GetProcessesByName("Weixin"))
        {
            using (process)
            {
                try
                {
                    process.Refresh();
                    if (!process.HasExited && process.MainWindowHandle != IntPtr.Zero &&
                        String.Equals(process.MainModule.FileName, ClientPath, StringComparison.OrdinalIgnoreCase))
                        snapshot.VisibleCount++;
                }
                catch (InvalidOperationException) { }
                catch (System.ComponentModel.Win32Exception) { snapshot.UnreadableCount++; }
            }
        }
        return snapshot;
    }

    [STAThread]
    private static void Main(string[] args)
    {
        if (args.Length == 1 && args[0] == "--self-test")
        {
            // Headless verification of this launcher only. Never launches the client.
            string version;
            string error = CheckOrStart(false, out version);
            ProcessSnapshot snapshot = VisibleProcesses();
            string report = "{\n  \"clientVersion\": \"" + version + "\",\n" +
                "  \"signatureAndProductValid\": " + (error == null ? "true" : "false") + ",\n" +
                "  \"selfTestClientLaunched\": false,\n  \"sourceIncludesNetworkOperations\": false,\n" +
                "  \"selfTestTouchesWeChatConfiguration\": false,\n" +
                "  \"officialClientWindowProcessCount\": " + snapshot.VisibleCount + ",\n" +
                "  \"unreadableProcessCount\": " + snapshot.UnreadableCount + "\n}\n";
            string reportPath = Path.Combine(Path.GetDirectoryName(Assembly.GetExecutingAssembly().Location), "launcher_self_test.json");
            try
            {
                using (FileStream output = new FileStream(reportPath, FileMode.CreateNew, FileAccess.Write, FileShare.Read))
                {
                    byte[] bytes = new UTF8Encoding(false).GetBytes(report);
                    output.Write(bytes, 0, bytes.Length);
                }
            }
            catch (IOException) { Environment.ExitCode = 2; return; }
            catch (UnauthorizedAccessException) { Environment.ExitCode = 2; return; }
            Environment.ExitCode = error == null ? 0 : 1;
            return;
        }
        if (args.Length != 0) return;
        Application.EnableVisualStyles();
        Application.SetCompatibleTextRenderingDefault(false);
        try
        {
            using (System.Threading.Mutex uiMutex = new System.Threading.Mutex(false, LauncherMutexName()))
            {
                bool ownsMutex;
                try { ownsMutex = uiMutex.WaitOne(0, false); }
                catch (System.Threading.AbandonedMutexException) { ownsMutex = true; }
                if (!ownsMutex) { BringExistingLauncherToFront(); return; }
                try { Application.Run(new LauncherForm()); }
                finally { uiMutex.ReleaseMutex(); }
            }
        }
        catch (UnauthorizedAccessException)
        {
            MessageBox.Show("启动器可能已用不同权限打开，请从任务栏切换到已有窗口。微信无需关闭。",
                "本地微信启动器", MessageBoxButtons.OK, MessageBoxIcon.Information);
        }
    }
}

internal sealed class LauncherForm : Form
{
    private readonly Label version = new Label();
    private readonly Label status = new Label();
    private readonly Label count = new Label();
    private readonly Timer timer = new Timer();
    private readonly Timer launchCooldown = new Timer();
    private readonly Button first = new Button();
    private readonly Button another = new Button();
    private bool launchBusy;
    private int requests;

    internal LauncherForm()
    {
        Text = "本地微信启动器";
        StartPosition = FormStartPosition.CenterScreen;
        ClientSize = new Size(580, 340);
        FormBorderStyle = FormBorderStyle.FixedDialog;
        MaximizeBox = false;
        AutoScaleMode = AutoScaleMode.Dpi;
        Font = new Font("Microsoft YaHei UI", 10F);
        // The desktop and application share the compiled icon; no current-directory dependency.
        Icon embeddedIcon = System.Drawing.Icon.ExtractAssociatedIcon(Assembly.GetExecutingAssembly().Location);
        if (embeddedIcon != null) Icon = embeddedIcon;

        Label title = new Label { Text = "官方微信，本地启动", Location = new Point(24, 22),
            AutoSize = true, Font = new Font("Microsoft YaHei UI", 16F, FontStyle.Bold) };
        Label explanation = new Label { Text = "只正常启动已核验的官方客户端，不操作账号或微信配置。\n微信可能按自己的设置恢复已有会话，登录与扫码请本人处理。",
            Location = new Point(24, 66), Size = new Size(534, 50) };
        version.Text = "启动时由 Windows 核验腾讯签名和微信产品信息";
        version.Location = new Point(24, 119);
        version.Size = new Size(534, 25);
        first.Text = "启动官方微信";
        first.Location = new Point(24, 160);
        first.Size = new Size(170, 42);
        another.Text = "请求再开一个窗口";
        another.Location = new Point(210, 160);
        another.Size = new Size(190, 42);
        Button refresh = new Button { Text = "刷新", Location = new Point(416, 160), Size = new Size(136, 42) };
        first.Click += delegate { StartClient(); };
        another.Click += delegate { StartClient(); };
        refresh.Click += delegate { RefreshCount(); };
        count.Location = new Point(24, 217);
        count.Size = new Size(534, 25);
        status.Location = new Point(24, 250);
        status.Size = new Size(534, 66);
        status.Text = "尚未发起启动请求。\n能否独立多开由官方客户端决定；两次请求不代表两个窗口。";
        Controls.AddRange(new Control[] { title, explanation, version, first, another, refresh, count, status });
        timer.Interval = 2000;
        timer.Tick += delegate { RefreshCount(); };
        timer.Start();
        launchCooldown.Interval = 1200;
        launchCooldown.Tick += delegate
        {
            launchCooldown.Stop();
            launchBusy = false;
            first.Enabled = true;
            another.Enabled = true;
        };
        RefreshCount();
    }

    private void RefreshCount()
    {
        Program.ProcessSnapshot snapshot = Program.VisibleProcesses();
        count.Text = "已发起请求：" + requests + " 次；有主窗口的官方微信进程：" + snapshot.VisibleCount + " 个";
        if (snapshot.UnreadableCount != 0) count.Text += "；不可读取：" + snapshot.UnreadableCount;
    }

    private async void StartClient()
    {
        if (launchBusy) return;
        launchBusy = true;
        first.Enabled = false;
        another.Enabled = false;
        try
        {
            status.Text = "正在核验官方微信…";
            string currentVersion = null;
            string error = await Task.Run(() => Program.CheckOrStart(true, out currentVersion));
            if (IsDisposed) return;
            if (error != null) { status.Text = error; return; }
            version.Text = "已核验版本：" + currentVersion + "（腾讯签名有效）";
            requests++;
            status.Text = "已向官方微信发起启动请求。";
            RefreshCount();
        }
        catch (Exception error)
        {
            status.Text = "启动未完成：" + error.Message;
        }
        finally
        {
            // One request per deliberate click, with a short double-click guard and no account cap.
            if (!IsDisposed) { launchCooldown.Stop(); launchCooldown.Start(); }
        }
    }

    protected override void OnFormClosed(FormClosedEventArgs e)
    {
        timer.Stop();
        timer.Dispose();
        launchCooldown.Stop();
        launchCooldown.Dispose();
        base.OnFormClosed(e);
    }
}
