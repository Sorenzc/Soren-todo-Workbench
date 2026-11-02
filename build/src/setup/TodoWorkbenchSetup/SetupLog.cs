using System;
using System.IO;
using System.Reflection;
using System.Text;

namespace TodoWorkbenchSetup
{
	/// <summary>安装程序的落盘日志：静默装失败时，这是唯一能看到的线索。
	/// 候选顺序：安装包所在目录（一定可写，否则连 exe 都拷不进来）→ %TEMP% → %LOCALAPPDATA%。</summary>
	internal static class SetupLog
	{
		private static readonly object Gate = new object();

		private static string path;

		public static string Path
		{
			get { return path; }
		}

		public static void Init()
		{
			foreach (string dir in Candidates())
			{
				try
				{
					Directory.CreateDirectory(dir);
					string file = System.IO.Path.Combine(dir, "setup.log");
					File.AppendAllText(file, "", new UTF8Encoding(false));
					path = file;
					break;
				}
				catch
				{
				}
			}
			W("==== setup start " + DateTime.Now.ToString("yyyy-MM-dd HH:mm:ss") + " log=" + (path ?? "(none)") + " ====");
		}

		private static string[] Candidates()
		{
			string exeDir = "";
			try
			{
				exeDir = System.IO.Path.GetDirectoryName(Assembly.GetExecutingAssembly().Location);
			}
			catch
			{
			}
			string temp = "";
			try
			{
				temp = System.IO.Path.Combine(System.IO.Path.GetTempPath(), "TodoWorkbench");
			}
			catch
			{
			}
			string local = "";
			try
			{
				local = System.IO.Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "TodoWorkbench");
			}
			catch
			{
			}
			return new string[] { exeDir, temp, local };
		}

		public static void W(string line)
		{
			if (path == null)
			{
				return;
			}
			try
			{
				lock (Gate)
				{
					File.AppendAllText(path, DateTime.Now.ToString("HH:mm:ss") + "  " + line + "\r\n", new UTF8Encoding(false));
				}
			}
			catch
			{
			}
		}
	}
}
