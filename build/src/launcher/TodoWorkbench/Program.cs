using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.IO.Compression;
using System.Net;
using System.Net.Sockets;
using System.Reflection;
using System.Security.Principal;
using System.Text;
using System.Text.RegularExpressions;
using System.Threading;
using System.Windows.Forms;
using Microsoft.Win32;

namespace TodoWorkbench
{
	internal static class Program
	{
		private static string logFile;

		private static string dataDir;

		private static string appDir;

		private static int runningPort;

		private static bool selftest;

		public static string LogFile
		{
			get
			{
				return logFile;
			}
		}

		public static string DataDir
		{
			get
			{
				return dataDir;
			}
		}

		public static string AppDir
		{
			get
			{
				return appDir;
			}
		}

		public static string ServerUrl
		{
			get
			{
				if (runningPort <= 0)
				{
					return "";
				}
				return "http://127.0.0.1:" + runningPort + "/";
			}
		}

		[STAThread]
		private static void Main(string[] args)
		{
			Application.EnableVisualStyles();
			Application.SetCompatibleTextRenderingDefault(false);
			string directoryName = Path.GetDirectoryName(Assembly.GetExecutingAssembly().Location);
			bool flag = HasArg(args, "--uninstall");
			selftest = HasArg(args, "--selftest");
			try
			{
				string text = ReadConfigDataDir(directoryName);
				dataDir = text ?? ResolvePortableDataDir(directoryName);
				InitLog(directoryName);
				Log("main args=[" + string.Join(" ", args) + "] exeDir=" + directoryName + " selftest=" + selftest);
				if (flag)
				{
					Application.Run(new UninstallForm(directoryName, dataDir));
					return;
				}
				if (HasArg(args, "--uninstall-silent"))
				{
					bool dropData = HasArg(args, "--drop-data");
					Environment.Exit((!Uninstaller.Purge(directoryName, dataDir, dropData)) ? 1 : 0);
				}
				if (selftest)
				{
					appDir = ResolveAppDir(directoryName);
					string text2 = EnsureServer();
					Log("selftest ok " + text2);
					StopServer();
					Environment.Exit(0);
				}
				using (TrayHost context = new TrayHost(directoryName))
				{
					Application.Run(context);
				}
			}
			catch (Exception ex)
			{
				Log("FATAL " + ex);
				if (!selftest)
				{
					MessageBox.Show("启动出错：" + ex.Message + "\n\n日志：" + (logFile ?? "(写不进去)"), "待办工作台", MessageBoxButtons.OK, MessageBoxIcon.Hand);
				}
				Environment.Exit(1);
			}
		}

		private static bool HasArg(string[] args, string name)
		{
			foreach (string a in args)
			{
				if (string.Equals(a, name, StringComparison.OrdinalIgnoreCase))
				{
					return true;
				}
			}
			return false;
		}

		public static string ReadConfigDataDir(string exeDir)
		{
			try
			{
				string path = Path.Combine(exeDir, "config.json");
				if (!File.Exists(path))
				{
					return null;
				}
				string input = File.ReadAllText(path, Encoding.UTF8);
				Match match = Regex.Match(input, "\"dataDir\"\\s*:\\s*\"((?:[^\"\\\\]|\\\\.)*)\"");
				if (!match.Success)
				{
					return null;
				}
				string text = Regex.Unescape(match.Groups[1].Value);
				return (text.Length > 0) ? text : null;
			}
			catch
			{
				return null;
			}
		}

		private static void InitLog(string exeDir)
		{
			string[] array = new string[4]
			{
				Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "TodoWorkbench", "logs"),
				Path.Combine(exeDir, "logs"),
				Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.CommonApplicationData), "TodoWorkbench", "logs"),
				Path.Combine(Path.GetTempPath(), "TodoWorkbench", "logs")
			};
			string[] array2 = array;
			string[] array3 = array2;
			foreach (string text in array3)
			{
				try
				{
					Directory.CreateDirectory(text);
					string path = Path.Combine(text, "launcher.log");
					File.AppendAllText(path, "");
					logFile = path;
					break;
				}
				catch
				{
				}
			}
		}

		public static string PrepareAppDir(string exeDir)
		{
			if (appDir == null)
			{
				appDir = ResolveAppDir(exeDir);
			}
			return appDir;
		}

		public static string StartServer(string exeDir)
		{
			if (appDir == null)
			{
				appDir = ResolveAppDir(exeDir);
			}
			return EnsureServer();
		}

		public static void Log(string msg)
		{
			try
			{
				if (logFile != null)
				{
					File.AppendAllText(logFile, DateTime.Now.ToString("yyyy-MM-dd HH:mm:ss") + "  " + msg + "\r\n", Encoding.UTF8);
				}
			}
			catch
			{
			}
		}

		private static string ResolveAppDir(string exeDir)
		{
			string text = FindInstalledAppDir(exeDir);
			if (text != null)
			{
				return text;
			}
			Assembly executingAssembly = Assembly.GetExecutingAssembly();
			if (!HasResource(executingAssembly, "payload.zip"))
			{
				return exeDir;
			}
			string version = AppInfo.Version;
			string[] array = new string[4]
			{
				Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "TodoWorkbench"),
				Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ApplicationData), "TodoWorkbench"),
				Path.Combine(Path.GetTempPath(), "TodoWorkbench"),
				Path.Combine(exeDir, ".app")
			};
			Exception ex = null;
			string[] array2 = array;
			string[] array3 = array2;
			foreach (string text2 in array3)
			{
				string text3 = Path.Combine(text2, "app-" + version);
				try
				{
					if (IsComplete(text3))
					{
						goto IL_0189;
					}
					if (!Writable(text2))
					{
						continue;
					}
					if (Directory.Exists(text3))
					{
						Directory.Delete(text3, true);
					}
					Directory.CreateDirectory(text3);
					string text4 = Path.Combine(text2, "payload-" + version + ".zip");
					using (Stream stream = executingAssembly.GetManifestResourceStream("payload.zip"))
					{
						using (FileStream destination = File.Create(text4))
						{
							stream.CopyTo(destination);
						}
					}
					ZipFile.ExtractToDirectory(text4, text3);
					try
					{
						File.Delete(text4);
					}
					catch
					{
					}
					File.WriteAllText(Path.Combine(text3, ".ready"), AppInfo.Version + "|" + NodeSize(text3), Encoding.UTF8);
					Log("extract -> " + text3);
					goto IL_0189;
					IL_0189:
					return text3;
				}
				catch (Exception ex2)
				{
					ex = ex2;
					Log("extract fail " + text2 + " : " + ex2.Message);
				}
			}
			throw new InvalidOperationException("首次启动解压失败：" + ((ex == null) ? "没有可写的目录" : ex.Message));
		}

		private static string FindInstalledAppDir(string exeDir)
		{
			try
			{
				string path = Path.Combine(exeDir, "app");
				if (!Directory.Exists(path))
				{
					return null;
				}
				List<string> list = new List<string>(Directory.GetDirectories(path));
				list.Sort((string a, string b) => CompareVer(Path.GetFileName(b), Path.GetFileName(a)));
				foreach (string item in list)
				{
					if (IsComplete(item))
					{
						return item;
					}
				}
			}
			catch
			{
			}
			return null;
		}

		private static int CompareVer(string x, string y)
		{
			try
			{
				Version version = Version.Parse(x);
				Version value = Version.Parse(y);
				return version.CompareTo(value);
			}
			catch
			{
				return string.Compare(x, y, StringComparison.OrdinalIgnoreCase);
			}
		}

		private static bool IsComplete(string dir)
		{
			try
			{
				string text = Path.Combine(dir, "node.exe");
				string path = Path.Combine(dir, "src", "server.mjs");
				string path2 = Path.Combine(dir, "public", "index.html");
				if (!File.Exists(text) || !File.Exists(path) || !File.Exists(path2))
				{
					return false;
				}
				string path3 = Path.Combine(dir, ".ready");
				if (!File.Exists(path3))
				{
					return true;
				}
				string[] array = File.ReadAllText(path3, Encoding.UTF8).Split('|');
				long result;
				if (array.Length == 2 && long.TryParse(array[1], out result) && result != new FileInfo(text).Length)
				{
					return false;
				}
				return true;
			}
			catch
			{
				return false;
			}
		}

		private static long NodeSize(string dir)
		{
			try
			{
				return new FileInfo(Path.Combine(dir, "node.exe")).Length;
			}
			catch
			{
				return -1L;
			}
		}

		private static bool HasResource(Assembly asm, string name)
		{
			string[] manifestResourceNames = asm.GetManifestResourceNames();
			string[] array = manifestResourceNames;
			foreach (string text in array)
			{
				if (text == name || text.EndsWith("." + name, StringComparison.OrdinalIgnoreCase))
				{
					return true;
				}
			}
			return false;
		}

		private static bool Writable(string dir)
		{
			try
			{
				Directory.CreateDirectory(dir);
				string path = Path.Combine(dir, ".w-" + Environment.TickCount + ".tmp");
				File.WriteAllText(path, "1");
				File.Delete(path);
				return true;
			}
			catch
			{
				return false;
			}
		}

		private static string ResolvePortableDataDir(string exeDir)
		{
			string text = Path.Combine(exeDir, "工作台数据");
			if (Writable(text))
			{
				try
				{
					Directory.CreateDirectory(Path.Combine(text, "backups"));
				}
				catch
				{
				}
				return text;
			}
			text = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "TodoWorkbench", "data");
			Directory.CreateDirectory(text);
			return text;
		}

		private static string EnsureServer()
		{
			runningPort = FindRunningPort();
			if (runningPort > 0)
			{
				Log("already running on " + runningPort);
				return "http://127.0.0.1:" + runningPort + "/";
			}
			string text = Path.Combine(appDir, "node.exe");
			string text2 = Path.Combine(appDir, "src", "server.mjs");
			if (!File.Exists(text) || !File.Exists(text2))
			{
				throw new FileNotFoundException("找不到 node.exe 或 src\\server.mjs，安装可能不完整：" + appDir);
			}
			Directory.CreateDirectory(Path.Combine(dataDir, "backups"));
			ProcessStartInfo processStartInfo = new ProcessStartInfo(text, "\"" + text2 + "\"");
			processStartInfo.WorkingDirectory = appDir;
			processStartInfo.UseShellExecute = false;
			processStartInfo.CreateNoWindow = true;
			processStartInfo.WindowStyle = ProcessWindowStyle.Hidden;
			processStartInfo.EnvironmentVariables["WB_NO_OPEN"] = "1";
			processStartInfo.EnvironmentVariables["WB_DB"] = Path.Combine(dataDir, "workbench.db");
			processStartInfo.EnvironmentVariables["WB_ARCHIVE"] = Path.Combine(dataDir, "archive");
			processStartInfo.EnvironmentVariables["WB_BACKUP"] = Path.Combine(dataDir, "backups");
			processStartInfo.EnvironmentVariables["WB_LOG"] = Path.Combine(dataDir, "server.log");
			Process process = Process.Start(processStartInfo);
			Log("node started pid=" + process.Id);
			Stopwatch stopwatch = Stopwatch.StartNew();
			while (stopwatch.ElapsedMilliseconds < 30000)
			{
				Thread.Sleep(200);
				if (process.HasExited)
				{
					throw new InvalidOperationException("本地服务启动后立即退出（退出码 " + process.ExitCode + "），详情见 server.log");
				}
				int num = FindRunningPort();
				if (num > 0)
				{
					runningPort = num;
					Log("server ready on " + num + " after " + stopwatch.ElapsedMilliseconds + "ms");
					return "http://127.0.0.1:" + num + "/";
				}
			}
			throw new TimeoutException("等了 30 秒本地服务还没起来，详情见 server.log");
		}

		public static int FindRunningPort()
		{
			int[] ports = AppInfo.Ports;
			int[] array = ports;
			foreach (int num in array)
			{
				if (IsListening(num) && Health(num) != null)
				{
					return num;
				}
			}
			return 0;
		}

		private static bool IsListening(int port)
		{
			try
			{
				using (TcpClient tcpClient = new TcpClient())
				{
					IAsyncResult asyncResult = tcpClient.BeginConnect("127.0.0.1", port, null, null);
					if (!asyncResult.AsyncWaitHandle.WaitOne(120))
					{
						return false;
					}
					tcpClient.EndConnect(asyncResult);
					return true;
				}
			}
			catch
			{
				return false;
			}
		}

		private static string Health(int port)
		{
			try
			{
				HttpWebRequest httpWebRequest = (HttpWebRequest)WebRequest.Create("http://127.0.0.1:" + port + "/api/health");
				httpWebRequest.Timeout = 700;
				httpWebRequest.ReadWriteTimeout = 700;
				httpWebRequest.Proxy = null;
				using (HttpWebResponse httpWebResponse = (HttpWebResponse)httpWebRequest.GetResponse())
				{
					using (StreamReader streamReader = new StreamReader(httpWebResponse.GetResponseStream(), Encoding.UTF8))
					{
						string text = streamReader.ReadToEnd();
						if (httpWebResponse.StatusCode == HttpStatusCode.OK && text.Contains("\"ok\":true") && text.Contains("todo-workbench"))
						{
							return text;
						}
					}
				}
			}
			catch
			{
			}
			return null;
		}

		public static bool StopServer()
		{
			int num = ReadPid();
			if (num <= 0)
			{
				return false;
			}
			try
			{
				Process processById = Process.GetProcessById(num);
				if (processById.MainModule != null && processById.MainModule.FileName.IndexOf("node.exe", StringComparison.OrdinalIgnoreCase) < 0)
				{
					Log("pid " + num + " 不是 node.exe，拒绝结束：" + processById.MainModule.FileName);
					return false;
				}
				processById.Kill();
				processById.WaitForExit(5000);
				Log("stopped pid " + num);
				return true;
			}
			catch (Exception ex)
			{
				Log("stop fail " + ex.Message);
				return false;
			}
		}

		private static int ReadPid()
		{
			try
			{
				string path = Path.Combine(dataDir, "server.pid");
				if (!File.Exists(path))
				{
					return 0;
				}
				int result;
				return int.TryParse(File.ReadAllText(path).Trim(), out result) ? result : 0;
			}
			catch
			{
				return 0;
			}
		}

		private static bool IsElevated()
		{
			try
			{
				WindowsIdentity current = WindowsIdentity.GetCurrent();
				return new WindowsPrincipal(current).IsInRole(WindowsBuiltInRole.Administrator);
			}
			catch
			{
				return false;
			}
		}

		public static bool OpenBrowser(string url)
		{
			bool flag = IsElevated();
			List<Func<string, bool>> list = new List<Func<string, bool>>();
			if (!flag)
			{
				list.Add(AppModeOpen);
				list.Add(ShellExecuteOpen);
			}
			list.Add(ExplorerOpen);
			list.Add(RundllOpen);
			list.Add(RegistryBrowserOpen);
			for (int i = 0; i < list.Count; i++)
			{
				try
				{
					if (list[i](url))
					{
						Log("open browser via #" + (i + 1) + (flag ? " (elevated)" : ""));
						Thread.Sleep(300);
						return true;
					}
				}
				catch (Exception ex)
				{
					Log("open #" + (i + 1) + " failed: " + ex.Message);
				}
			}
			return false;
		}

		private static bool AppModeOpen(string url)
		{
			string[] array = new string[5]
			{
				Environment.GetEnvironmentVariable("ProgramFiles(x86)") + "\\Microsoft\\Edge\\Application\\msedge.exe",
				Environment.GetEnvironmentVariable("ProgramFiles") + "\\Microsoft\\Edge\\Application\\msedge.exe",
				Environment.GetEnvironmentVariable("ProgramFiles") + "\\Google\\Chrome\\Application\\chrome.exe",
				Environment.GetEnvironmentVariable("ProgramFiles(x86)") + "\\Google\\Chrome\\Application\\chrome.exe",
				Environment.GetEnvironmentVariable("LocalAppData") + "\\Google\\Chrome\\Application\\chrome.exe"
			};
			foreach (string text in array)
			{
				if (string.IsNullOrEmpty(text) || !File.Exists(text))
				{
					continue;
				}
				// 先用用户自己的 profile（最稳，已登录的浏览器直接复用）；
				// 被占用/被拒时再用工作台自己的 profile 兜底。
				string[] array2 = new string[2]
				{
					null,
					ResolveBrowserProfileDir()
				};
				foreach (string text2 in array2)
				{
					try
					{
						string text3 = "--app=" + url + " --window-size=1440,900 --no-first-run --no-default-browser-check --disable-sync --disable-features=msEdgeSyncPromo,msEdgeSigninPromo";
						if (!string.IsNullOrEmpty(text2))
						{
							text3 = text3 + " --user-data-dir=\"" + text2 + "\"";
						}
						ProcessStartInfo processStartInfo = new ProcessStartInfo(text, text3);
						processStartInfo.UseShellExecute = true;
						Process process = Process.Start(processStartInfo);
						Log("app-mode via " + text + (string.IsNullOrEmpty(text2) ? " (default profile)" : " profile=" + text2));
						if (WaitForAppWindow(6000))
						{
							return true;
						}
						Log("app-mode opened but page did not load, trying next");
						if (process != null && !process.HasExited)
						{
							try
							{
								process.Kill();
							}
							catch (Exception ex)
							{
								Log("kill blank app window failed: " + ex.Message);
							}
						}
					}
					catch (Exception ex2)
					{
						Log("app-mode failed (" + text + "): " + ex2.Message);
					}
				}
			}
			return false;
		}

		private static bool ShellExecuteOpen(string url)
		{
			ProcessStartInfo processStartInfo = new ProcessStartInfo(url);
			processStartInfo.UseShellExecute = true;
			Process.Start(processStartInfo);
			return true;
		}

		private static string ResolveBrowserProfileDir()
		{
			string text = (string.IsNullOrEmpty(DataDir) ? Path.Combine(Path.GetTempPath(), "TodoWorkbench") : DataDir);
			string text2 = Path.Combine(text, "profiles", "appwindow");
			try
			{
				Directory.CreateDirectory(text2);
			}
			catch (Exception ex)
			{
				Log("create profile dir failed: " + ex.Message);
			}
			return text2;
		}

		// 找一个空闲端口给 Chromium 的远程调试用（只绑定 127.0.0.1）
		private static int FindFreePort(int start)
		{
			for (int i = 0; i < 60; i++)
			{
				int num = start + i;
				try
				{
					TcpListener tcpListener = new TcpListener(IPAddress.Loopback, num);
					tcpListener.Start();
					tcpListener.Stop();
					return num;
				}
				catch (Exception)
				{
				}
			}
			return start;
		}

		// 轮询 CDP，直到目标页确实指向我们的地址；返回 false 表示这个 app 窗口是空的
		private static bool ConfirmAppWindow(int cdpPort, string appUrl)
		{
			string text = appUrl.TrimEnd('/');
			for (int i = 0; i < 40; i++)
			{
				try
				{
					HttpWebRequest httpWebRequest = (HttpWebRequest)WebRequest.Create("http://127.0.0.1:" + cdpPort + "/json/list");
					httpWebRequest.Timeout = 1200;
					httpWebRequest.Proxy = null;
					using (HttpWebResponse httpWebResponse = (HttpWebResponse)httpWebRequest.GetResponse())
					{
						using (Stream responseStream = httpWebResponse.GetResponseStream())
						{
							using (StreamReader streamReader = new StreamReader(responseStream, Encoding.UTF8))
							{
								string text2 = streamReader.ReadToEnd();
								if (text2.IndexOf("\"url\": \"" + text, StringComparison.OrdinalIgnoreCase) >= 0 || text2.IndexOf("\"url\":\"" + text, StringComparison.OrdinalIgnoreCase) >= 0)
								{
									return true;
								}
							}
						}
					}
				}
				catch (Exception)
				{
				}
				Thread.Sleep(250);
			}
			return false;
		}

		// 只有当一个 Edge/Chrome 窗口的标题真的是工作台，才算“浏览器打开了”；
		// 空白窗口的标题是 127.0.0.1，靠这个把它识别出来并退到默认浏览器。
		public static bool WaitForAppWindow(int timeoutMs)
		{
			int tickCount = Environment.TickCount;
			string value = AppInfo.Name ?? "待办工作台";
			while (Environment.TickCount - tickCount < timeoutMs)
			{
				Process[] processes = Process.GetProcesses();
				foreach (Process process in processes)
				{
					try
					{
						string text = process.ProcessName.ToLowerInvariant();
						if (text != "msedge" && text != "chrome")
						{
							continue;
						}
						string mainWindowTitle = process.MainWindowTitle;
						if (mainWindowTitle != null && mainWindowTitle.IndexOf(value, StringComparison.Ordinal) >= 0)
						{
							Log("app window title matched: " + mainWindowTitle);
							return true;
						}
					}
					catch (Exception)
					{
					}
				}
				Thread.Sleep(250);
			}
			return false;
		}

		private static bool ExplorerOpen(string url)
		{
			ProcessStartInfo processStartInfo = new ProcessStartInfo("explorer.exe", "\"" + url + "\"");
			processStartInfo.UseShellExecute = false;
			processStartInfo.CreateNoWindow = true;
			Process.Start(processStartInfo);
			return true;
		}

		private static bool RundllOpen(string url)
		{
			ProcessStartInfo processStartInfo = new ProcessStartInfo("rundll32.exe", "url.dll,FileProtocolHandler \"" + url + "\"");
			processStartInfo.UseShellExecute = false;
			processStartInfo.CreateNoWindow = true;
			Process.Start(processStartInfo);
			return true;
		}

		private static bool RegistryBrowserOpen(string url)
		{
			string text = null;
			using (RegistryKey registryKey = Registry.CurrentUser.OpenSubKey("Software\\Microsoft\\Windows\\Shell\\Associations\\UrlAssociations\\http\\UserChoice"))
			{
				if (registryKey != null)
				{
					text = registryKey.GetValue("ProgId") as string;
				}
			}
			if (string.IsNullOrEmpty(text))
			{
				return false;
			}
			string text2 = null;
			using (RegistryKey registryKey2 = Registry.ClassesRoot.OpenSubKey(text + "\\shell\\open\\command"))
			{
				if (registryKey2 != null)
				{
					text2 = registryKey2.GetValue(null) as string;
				}
			}
			if (string.IsNullOrEmpty(text2))
			{
				return false;
			}
			Match match = Regex.Match(text2, "^\"([^\"]+)\"");
			string text3 = (match.Success ? match.Groups[1].Value : text2.Split(' ')[0]);
			if (!File.Exists(text3))
			{
				return false;
			}
			ProcessStartInfo processStartInfo = new ProcessStartInfo(text3, "\"" + url + "\"");
			processStartInfo.UseShellExecute = false;
			Process.Start(processStartInfo);
			return true;
		}

		public static void CopyText(string text)
		{
			try
			{
				Clipboard.SetText(text);
			}
			catch
			{
			}
		}

		public static void OpenFolder(string dir)
		{
			try
			{
				if (Directory.Exists(dir))
				{
					Process.Start("explorer.exe", "\"" + dir + "\"");
				}
			}
			catch
			{
			}
		}

		public static string LogTail(int lines)
		{
			try
			{
				string text = "";
				if (logFile != null && File.Exists(logFile))
				{
					text = text + "== launcher.log ==\r\n" + Tail(logFile, lines) + "\r\n";
				}
				string text2 = Path.Combine(dataDir, "server.log");
				if (File.Exists(text2))
				{
					text = text + "== server.log ==\r\n" + Tail(text2, lines * 3);
				}
				return text;
			}
			catch (Exception ex)
			{
				return "读日志失败：" + ex.Message;
			}
		}

		private static string Tail(string file, int lines)
		{
			try
			{
				string[] array = File.ReadAllLines(file, Encoding.UTF8);
				int num = Math.Max(0, array.Length - lines);
				StringBuilder stringBuilder = new StringBuilder();
				for (int i = num; i < array.Length; i++)
				{
					stringBuilder.AppendLine(array[i]);
				}
				return stringBuilder.ToString();
			}
			catch
			{
				return "(读不出来)";
			}
		}
	}
}
