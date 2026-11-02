using System;
using System.IO;
using System.Runtime.InteropServices.ComTypes;
using System.Threading;

namespace TodoWorkbenchSetup
{
	/// <summary>开始菜单 / 桌面快捷方式。
	/// 注意：IShellLink 的 Save() 在个别环境（没有交互式 shell、被安全软件拦）会卡住，
	/// 所以这里一律放到后台线程上跑并设超时——快捷方式失败不能把安装卡死。</summary>
	internal static class Shortcuts
	{
		public static bool CreateStartMenu(string exe, string workDir)
		{
			return RunWithTimeout(delegate
			{
				string path = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.Programs));
				Create(Path.Combine(path, "待办工作台.lnk"), exe, workDir, null);
				Create(Path.Combine(path, "待办工作台（不自动开浏览器）.lnk"), exe, workDir, "--no-browser");
			}, 10000);
		}

		public static bool CreateDesktop(string exe, string workDir)
		{
			return RunWithTimeout(delegate
			{
				string folderPath = Environment.GetFolderPath(Environment.SpecialFolder.DesktopDirectory);
				Create(Path.Combine(folderPath, "待办工作台.lnk"), exe, workDir, null);
			}, 10000);
		}

		private static bool RunWithTimeout(Action action, int timeoutMs)
		{
			Thread thread = new Thread((ThreadStart)delegate
			{
				try
				{
					action();
				}
				catch (Exception ex)
				{
					SetupLog.W("warn: shortcut failed -> " + ex.Message);
				}
			});
			thread.IsBackground = true;
			thread.SetApartmentState(ApartmentState.STA);
			thread.Start();
			bool flag = thread.Join(timeoutMs);
			if (!flag)
			{
				SetupLog.W("warn: shortcut creation timed out after " + timeoutMs + "ms (skipped)");
			}
			return flag;
		}

		private static void Create(string linkPath, string exe, string workDir, string args)
		{
			Directory.CreateDirectory(Path.GetDirectoryName(linkPath));
			IShellLinkW shellLinkW = (IShellLinkW)new ShellLink();
			shellLinkW.SetPath(exe);
			shellLinkW.SetWorkingDirectory(workDir);
			shellLinkW.SetDescription("待办工作台 — 本地待办工作台");
			shellLinkW.SetIconLocation(exe, 0);
			if (args != null)
			{
				shellLinkW.SetArguments(args);
			}
			((IPersistFile)shellLinkW).Save(linkPath, false);
			SetupLog.W("shortcut ok -> " + linkPath);
		}
	}
}
