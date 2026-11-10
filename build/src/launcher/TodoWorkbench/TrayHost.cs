using System;
using System.Drawing;
using System.IO;
using System.Net;
using System.Text;
using System.Text.RegularExpressions;
using System.Threading;
using System.Windows.Forms;

namespace TodoWorkbench
{
	internal sealed class TrayHost : ApplicationContext
	{
		private readonly NotifyIcon tray;

		private readonly string exeDir;

		private readonly StatusForm splash;

		private string url;

		// 托盘侧提醒轮询：页面关掉后只剩这一条通道，靠服务端的 remind_fired 抢占去重
		private Thread reminderThread;

		private volatile bool reminderAlive = true;

		private string token;

		public TrayHost(string exeDir)
		{
			this.exeDir = exeDir;
			splash = new StatusForm();
			StatusForm statusForm = splash;
			Action value = delegate
			{
				ShowFailure("浏览器没能自动打开", "工作台已经在后台跑了，只是没能把浏览器叫起来。");
			};
			statusForm.OnStuck += value;
			splash.Show();
			tray = new NotifyIcon();
			tray.Icon = LoadAppIcon();
			tray.Text = "待办工作台";
			tray.Visible = true;
			tray.DoubleClick += delegate
			{
				Open();
			};
			ContextMenuStrip contextMenuStrip = new ContextMenuStrip
			{
				Items = 
				{
					{
						"打开工作台",
						(Image)null,
						(EventHandler)delegate
						{
							Open();
						}
					},
					{
						"复制地址",
						(Image)null,
						(EventHandler)delegate
						{
							if (url != null)
							{
								Program.CopyText(url);
							}
						}
					},
					{
						"打开数据目录",
						(Image)null,
						(EventHandler)delegate
						{
							Program.OpenFolder(Program.DataDir);
						}
					},
					{
						"查看日志",
						(Image)null,
						(EventHandler)delegate
						{
							ShowLog();
						}
					},
					(ToolStripItem)new ToolStripSeparator(),
					{
						"退出（停止服务）",
						(Image)null,
						(EventHandler)delegate
						{
							Quit();
						}
					}
				}
			};
			tray.ContextMenuStrip = contextMenuStrip;
			tray.BalloonTipClicked += delegate
			{
				Open();
			};
			Thread thread = new Thread(Run);
			thread.IsBackground = true;
			thread.Start();
			StartReminderLoop();
		}

		private void StartReminderLoop()
		{
			reminderThread = new Thread(ReminderLoop);
			reminderThread.IsBackground = true;
			reminderThread.Start();
		}

		/// <summary>
		/// 每 30 秒问一次 /api/reminders。服务端起不来、端口还没定、token 还没写，
		/// 都只是「下一轮再说」，绝不在这里弹错误——托盘是后台进程，不能吓人。
		/// </summary>
		private void ReminderLoop()
		{
			while (reminderAlive)
			{
				try
				{
					string baseUrl = Program.ServerUrl;
					if (!string.IsNullOrEmpty(baseUrl))
					{
						if (string.IsNullOrEmpty(token))
						{
							token = ReadToken();
						}
						if (!string.IsNullOrEmpty(token))
						{
							string body = GetJson(baseUrl + "api/reminders", token);
							if (!string.IsNullOrEmpty(body))
							{
								foreach (string title in ExtractTitles(body))
								{
									ShowReminder(title);
								}
							}
						}
					}
				}
				catch (Exception ex)
				{
					Program.Log("reminder poll failed: " + ex.Message);
				}
				Thread.Sleep(30000);
			}
		}

		private static string ReadToken()
		{
			try
			{
				string path = Path.Combine(Program.DataDir, "token.txt");
				if (File.Exists(path))
				{
					string text = File.ReadAllText(path).Trim();
					return (text.Length > 0) ? text : null;
				}
			}
			catch (Exception ex)
			{
				Program.Log("read token failed: " + ex.Message);
			}
			return null;
		}

		private static string GetJson(string url, string token)
		{
			HttpWebRequest httpWebRequest = (HttpWebRequest)WebRequest.Create(url);
			httpWebRequest.Timeout = 3000;
			httpWebRequest.ReadWriteTimeout = 3000;
			httpWebRequest.Proxy = null;
			httpWebRequest.Headers.Add("x-wb-token", token);
			using (HttpWebResponse httpWebResponse = (HttpWebResponse)httpWebRequest.GetResponse())
			{
				if (httpWebResponse.StatusCode != HttpStatusCode.OK)
				{
					return null;
				}
				using (StreamReader streamReader = new StreamReader(httpWebResponse.GetResponseStream(), Encoding.UTF8))
				{
					return streamReader.ReadToEnd();
				}
			}
		}

		/// <summary>
		/// 只取每条提醒的 title：为了几行字引一个 JSON 库不值当，
		/// 服务端返回的结构固定是 {"reminders":[{"title":"…"},…],"now":"…"}。
		/// </summary>
		private static System.Collections.Generic.List<string> ExtractTitles(string json)
		{
			System.Collections.Generic.List<string> titles = new System.Collections.Generic.List<string>();
			MatchCollection matches = Regex.Matches(json, "\"title\"\\s*:\\s*\"((?:[^\"\\\\]|\\\\.)*)\"");
			foreach (Match match in matches)
			{
				titles.Add(JsonUnescape(match.Groups[1].Value));
			}
			return titles;
		}

		private static string JsonUnescape(string text)
		{
			if (text.IndexOf('\\') < 0)
			{
				return text;
			}
			return Regex.Replace(text, "\\\\u([0-9a-fA-F]{4})|\\\\([\"\\\\/bfnrt])", delegate(Match m)
			{
				if (m.Groups[1].Success)
				{
					return ((char)Convert.ToInt32(m.Groups[1].Value, 16)).ToString();
				}
				switch (m.Groups[2].Value)
				{
				case "\"":
					return "\"";
				case "\\":
					return "\\";
				case "/":
					return "/";
				case "b":
				case "f":
					return " ";
				case "n":
				case "r":
				case "t":
					return " ";
				default:
					return m.Value;
				}
			});
		}

		private void ShowReminder(string title)
		{
			Ui(delegate
			{
				tray.BalloonTipTitle = "待办提醒";
				tray.BalloonTipText = title;
				tray.BalloonTipIcon = ToolTipIcon.Info;
				tray.ShowBalloonTip(8000);
			});
		}

		private void Run()
		{
			try
			{
				Ui(delegate
				{
					splash.SetStatus("正在准备运行组件…");
				});
				Program.PrepareAppDir(exeDir);
				if (Program.FindRunningPort() == 0)
				{
					Ui(delegate
					{
						splash.SetStatus("正在启动本地服务…");
					});
				}
				url = Program.StartServer(exeDir);
				Ui(delegate
				{
					splash.SetStatus("正在打开浏览器…");
					splash.SetStuck(true);
				});
				if (!Program.OpenBrowser(url))
				{
					Ui(delegate
					{
						ShowFailure("浏览器没能自动打开", "工作台已经在后台跑起来了，只是没能把浏览器叫起来。");
					});
					return;
				}
				Ui(delegate
				{
					tray.Text = "待办工作台 · 已运行";
					splash.SetStatus("已打开。窗口 3 秒后收起，双击右下角图标可以再打开。");
					splash.SetStuck(false);
				});
				Thread.Sleep(1800);
				Ui(delegate
				{
					splash.Hide();
				});
			}
			catch (Exception ex)
			{
				Exception ex2 = ex;
				Program.Log("run flow failed " + ex2);
				string headline = "本地服务没有起来";
				ErrorCodes.Current = "WB-E02";
				if (ex2 is FileNotFoundException)
				{
					headline = "程序文件不完整";
					ErrorCodes.Current = "WB-E08";
				}
				else if (ex2 is TimeoutException)
				{
					headline = "本地服务启动超时";
					ErrorCodes.Current = "WB-E01";
				}
				else if (ex2 is UnauthorizedAccessException)
				{
					headline = "没有权限写数据目录";
					ErrorCodes.Current = "WB-E03";
				}
				Ui(delegate
				{
					ShowFailure(headline, ex2.Message);
				});
			}
		}

		private void Ui(Action action)
		{
			try
			{
				if (!splash.IsDisposed)
				{
					splash.BeginInvoke(action);
				}
			}
			catch
			{
			}
		}

		private void ShowFailure(string headline, string why)
		{
			try
			{
				splash.Hide();
				ErrorPanel errorPanel = new ErrorPanel(headline, why, url ?? Program.ServerUrl, Program.DataDir);
				errorPanel.Show();
			}
			catch (Exception ex)
			{
				Program.Log("panel failed " + ex.Message);
			}
		}

		private void Open()
		{
			if (url == null)
			{
				int num = Program.FindRunningPort();
				if (num > 0)
				{
					url = "http://127.0.0.1:" + num + "/";
				}
			}
			if (url == null)
			{
				ShowFailure("还没启动成功", "本地服务没有在跑。可以关掉这个窗口，重新双击图标。");
			}
			else if (!Program.OpenBrowser(url))
			{
				ShowFailure("浏览器没能自动打开", "工作台已经在后台跑了，只是没能把浏览器叫起来。");
			}
		}

		private void ShowLog()
		{
			MessageBox.Show(Program.LogTail(40), "日志 · 待办工作台", MessageBoxButtons.OK, MessageBoxIcon.Asterisk);
		}

		private void Quit()
		{
			if (MessageBox.Show("停止后台服务并退出？\r\n待办数据不会被删除。", "待办工作台", MessageBoxButtons.OKCancel, MessageBoxIcon.Question) == DialogResult.OK)
			{
				reminderAlive = false;
				Program.StopServer();
				tray.Visible = false;
				ExitThread();
			}
		}

		private static Icon LoadAppIcon()
		{
			try
			{
				Icon icon = Icon.ExtractAssociatedIcon(Application.ExecutablePath);
				if (icon != null)
				{
					return icon;
				}
			}
			catch (Exception ex)
			{
				Program.Log("tray icon failed: " + ex.Message);
			}
			return SystemIcons.Application;
		}
	}
}
