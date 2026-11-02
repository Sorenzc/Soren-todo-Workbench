using System;
using System.Diagnostics;
using System.Drawing;
using System.IO;
using System.IO.Compression;
using System.Reflection;
using System.Text;
using System.Threading;
using System.Windows.Forms;
using Microsoft.Win32;

namespace TodoWorkbenchSetup
{
	internal sealed class InstallRunner : Form
	{
		private readonly Ini ini;

		private readonly bool silent;

		private readonly Label status;

		private readonly ProgressBar bar;

		public bool SelfCheckOk;

		public string SelfCheckMessage = "";

		public int Result = 1;

		public event Action<string, int> Progress;

		public event Action<string> Stage;

		public event Action<int, string> Done;

		public InstallRunner(Ini ini, bool silent)
		{
			this.ini = ini;
			this.silent = silent;
			Text = "正在安装 待办工作台";
			base.StartPosition = FormStartPosition.CenterScreen;
			base.ClientSize = new Size(520, 130);
			base.FormBorderStyle = FormBorderStyle.FixedDialog;
			base.MaximizeBox = false;
			base.MinimizeBox = false;
			base.ControlBox = false;
			BackColor = Color.White;
			Font = new Font("Microsoft YaHei UI", 9.75f);
			status = new Label();
			status.Text = "正在安装…";
			status.Bounds = new Rectangle(20, 26, 480, 24);
			base.Controls.Add(status);
			bar = new ProgressBar();
			bar.Bounds = new Rectangle(20, 60, 480, 16);
			bar.Style = ProgressBarStyle.Marquee;
			base.Controls.Add(bar);
		}

		public void Start()
		{
			Thread thread = new Thread(Work);
			thread.IsBackground = true;
			thread.Start();
		}

		private void SetText(string text)
		{
			try
			{
				if (!base.IsDisposed)
				{
					BeginInvoke((Action)delegate
					{
						status.Text = text;
					});
				}
			}
			catch
			{
			}
		}

		private void SetBar(int percent)
		{
			try
			{
				if (base.IsDisposed)
				{
					return;
				}
				BeginInvoke((Action)delegate
				{
					bar.Style = ((percent >= 0) ? ProgressBarStyle.Continuous : ProgressBarStyle.Marquee);
					if (percent >= 0)
					{
						bar.Value = Math.Min(100, percent);
					}
				});
			}
			catch
			{
			}
		}

		private void Work()
		{
			string text = (ini.Dir ?? Paths.DefaultDir(ini.Machine)).TrimEnd('\\');
			SetupLog.W("work start dir=" + text + " silent=" + silent);
			try
			{
				Report("正在检查安装位置…", 5, "✓ 检查安装位置");
				if (!Directory.Exists(text))
				{
					Directory.CreateDirectory(text);
				}
				Report("正在解压运行组件…（约 30 秒，仅首次安装需要这么久）", -1, "· 复制程序文件");
				int num = ExtractBundle(text);
				Report("正在写配置文件…", 88, "✓ 复制程序文件（" + num + " 个）");
				SetupLog.W("extracted files=" + num);
				WriteConfig(text);
				SetupLog.W("config written");
				Report("正在注册开始菜单…", 92, "✓ 注册开始菜单");
				SetupLog.W("start menu begin");
				if (!Shortcuts.CreateStartMenu(Path.Combine(text, "待办工作台.exe"), text))
				{
					SetupLog.W("warn: start menu skipped");
				}
				SetupLog.W("start menu ok");
				Report("正在写卸载信息…", 96, "✓ 写入卸载信息");
				try
				{
					WriteUninstallEntry(text);
					SetupLog.W("uninstall entry ok");
				}
				catch (Exception ex3)
				{
					// 没有卸载注册项不影响使用：卸载入口还有 托盘菜单 → 卸载、安装目录里的 exe --uninstall
					SetupLog.W("warn: uninstall entry failed -> " + ex3.Message);
				}
				if (silent && ini.Desktop)
				{
					Shortcuts.CreateDesktop(Path.Combine(text, "待办工作台.exe"), text);
					SetupLog.W("desktop shortcut ok");
				}
				Report("正在自检…", 98, "✓ 安装完成，正在自检");
				SelfCheckOk = true;
				SelfCheckMessage = "自检通过：本地服务能正常启动。";
				try
				{
					ProcessStartInfo processStartInfo = new ProcessStartInfo(Path.Combine(text, "待办工作台.exe"), "--selftest");
					processStartInfo.UseShellExecute = false;
					processStartInfo.CreateNoWindow = true;
					processStartInfo.WorkingDirectory = text;
					using (Process process = Process.Start(processStartInfo))
					{
						bool exited = process.WaitForExit(60000);
						SetupLog.W("selftest exited=" + exited + " code=" + (exited ? process.ExitCode : -1));
						if (!exited || process.ExitCode != 0)
						{
							SelfCheckOk = false;
							SelfCheckMessage = "自检没有通过：本地服务没能启动（自检退出码 " + (exited ? process.ExitCode : -1) + "，日志见安装目录 logs）。";
						}
					}
				}
				catch (Exception ex)
				{
					SelfCheckOk = false;
					SelfCheckMessage = "自检没有跑起来：" + ex.Message;
				}
				Report("安装完成", 100, "✓ 完成");
				Result = 0;
				if (silent && ini.Launch)
				{
					try
					{
						ProcessStartInfo processStartInfo2 = new ProcessStartInfo(Path.Combine(text, "待办工作台.exe"));
						processStartInfo2.UseShellExecute = true;
						processStartInfo2.WorkingDirectory = text;
						Process.Start(processStartInfo2);
					}
					catch
					{
					}
				}
				FinishUi(0, "ok");
			}
			catch (Exception ex2)
			{
				Result = 1;
				SetupLog.W("work failed " + ex2);
				FinishUi(1, ex2.Message);
			}
		}

		private void Report(string head, int percent, string stageLine)
		{
			SetText(head);
			SetBar(percent);
			if (this.Progress != null)
			{
				this.Progress(head, percent);
			}
			if (this.Stage != null)
			{
				this.Stage(stageLine);
			}
			bool silent2 = silent;
		}

		private void FinishUi(int code, string message)
		{
			try
			{
				if (!base.IsDisposed)
				{
					BeginInvoke((Action)delegate
					{
						if (this.Done != null)
						{
							this.Done(code, message);
						}
						if (silent)
						{
							Close();
						}
					});
				}
			}
			catch
			{
			}
			if (!silent)
			{
				return;
			}
			try
			{
				if (!base.IsDisposed)
				{
					BeginInvoke((Action)delegate
					{
						Close();
					});
				}
			}
			catch
			{
			}
		}

		private int ExtractBundle(string dir)
		{
			SetupLog.W("extract start dir=" + dir);
			Assembly executingAssembly = Assembly.GetExecutingAssembly();
			SetupLog.W("resources=" + string.Join(",", executingAssembly.GetManifestResourceNames()));
			string text = Path.Combine(dir, "app", "1.1.0");
			if (Directory.Exists(text))
			{
				Directory.Delete(text, true);
			}
			Directory.CreateDirectory(text);
			int num = 0;
			// 直接从内存里的资源解压：不落 %TEMP%，避免临时目录不可写 / 被杀软锁住导致装不上
			using (Stream stream = executingAssembly.GetManifestResourceStream("bundle.zip"))
			{
				if (stream == null)
				{
					throw new InvalidOperationException("安装包里没有程序文件（bundle.zip 缺失）。");
				}
				using (ZipArchive zipArchive = new ZipArchive(stream, ZipArchiveMode.Read))
				{
					foreach (ZipArchiveEntry entry in zipArchive.Entries)
					{
						string text3 = Path.Combine(text, entry.FullName);
						if (entry.FullName.EndsWith("/"))
						{
							Directory.CreateDirectory(text3);
							continue;
						}
						Directory.CreateDirectory(Path.GetDirectoryName(text3));
						entry.ExtractToFile(text3, true);
						num++;
					}
				}
			}
			string text4 = Path.Combine(text, "Launcher.exe");
			if (!File.Exists(text4))
			{
				throw new InvalidOperationException("安装包里缺少启动器。");
			}
			string text5 = Path.Combine(dir, "待办工作台.exe");
			if (File.Exists(text5))
			{
				File.Delete(text5);
			}
			File.Copy(text4, text5);
			try
			{
				File.Delete(text4);
			}
			catch
			{
			}
			File.WriteAllText(Path.Combine(text, ".ready"), "1.1.0", Encoding.UTF8);
			return num;
		}

		private void WriteConfig(string dir)
		{
			// 数据目录只在装的时候“尽量”建一下：建不出来不算安装失败，
			// 启动器首次运行会自己按 可写目录链 落数据，并把实际路径写回 config.json
			string dataDir = string.IsNullOrWhiteSpace(ini.DataDir) ? Paths.DataDir : ini.DataDir.Trim().TrimEnd('\\');
			try
			{
				Directory.CreateDirectory(dataDir);
			}
			catch (Exception ex)
			{
				SetupLog.W("warn: create data dir " + dataDir + " -> " + ex.Message + "（留给启动器首次运行时决定）");
			}
			string contents = "{\r\n  \"dataDir\": \"" + dataDir.Replace("\\", "\\\\") + "\",\r\n  \"version\": \"1.1.0\",\r\n  \"scope\": \"" + (ini.Machine ? "machine" : "user") + "\"\r\n}\r\n";
			File.WriteAllText(Path.Combine(dir, "config.json"), contents, new UTF8Encoding(false));
		}

		private void WriteUninstallEntry(string dir)
		{
			string text = Path.Combine(dir, "待办工作台.exe");
			RegistryKey registryKey = (ini.Machine ? RegistryKey.OpenBaseKey(RegistryHive.LocalMachine, RegistryView.Registry64) : RegistryKey.OpenBaseKey(RegistryHive.CurrentUser, RegistryView.Default));
			using (registryKey)
			{
				using (RegistryKey registryKey2 = registryKey.CreateSubKey("Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\TodoWorkbench"))
				{
					registryKey2.SetValue("DisplayName", "待办工作台", RegistryValueKind.String);
					registryKey2.SetValue("DisplayVersion", "1.1.0", RegistryValueKind.String);
					registryKey2.SetValue("Publisher", "陈春天的哥哥", RegistryValueKind.String);
					registryKey2.SetValue("DisplayIcon", text + ",0", RegistryValueKind.String);
					registryKey2.SetValue("InstallLocation", dir, RegistryValueKind.String);
					registryKey2.SetValue("UninstallString", "\"" + text + "\" --uninstall", RegistryValueKind.String);
					registryKey2.SetValue("QuietUninstallString", "\"" + text + "\" --uninstall", RegistryValueKind.String);
					registryKey2.SetValue("InstallDate", DateTime.Now.ToString("yyyyMMdd"), RegistryValueKind.String);
					registryKey2.SetValue("NoModify", 1, RegistryValueKind.DWord);
					registryKey2.SetValue("NoRepair", 1, RegistryValueKind.DWord);
					long num = 0L;
					try
					{
						string[] files = Directory.GetFiles(dir, "*", SearchOption.AllDirectories);
						foreach (string fileName in files)
						{
							num += new FileInfo(fileName).Length;
						}
					}
					catch
					{
					}
					registryKey2.SetValue("EstimatedSize", (int)(num / 1024), RegistryValueKind.DWord);
				}
			}
		}
	}
}
