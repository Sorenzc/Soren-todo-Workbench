using System;
using System.Drawing;
using System.IO;
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
			Thread thread = new Thread(Run);
			thread.IsBackground = true;
			thread.Start();
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
