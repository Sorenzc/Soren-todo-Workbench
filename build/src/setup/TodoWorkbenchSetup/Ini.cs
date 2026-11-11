using System;

namespace TodoWorkbenchSetup
{
	internal sealed class Ini
	{
		public bool Elevated;

		public string Dir;

		/// <summary>数据目录覆盖（--data=...），不传则用默认的 %LOCALAPPDATA%\TodoWorkbench\data。</summary>
		public string DataDir;

		public bool Machine;

		public bool Desktop = true;

		public bool Launch;

		public bool Help;

		/// <summary>开发用：不弹窗，只把向导控件边界写进日志并退出。</summary>
		public bool LayoutCheck;

		/// <summary>开发用：直接打开某一页（1/2/3），方便截图核对排版。</summary>
		public int Preview;

		/// <summary>开发用：把向导窗口画成 PNG 存到这个路径，然后退出（不安装）。</summary>
		public string ShotPath;

		public static Ini Parse(string[] args)
		{
			Ini ini = new Ini();
			foreach (string text in args)
			{
				if (string.Equals(text, "--elevated", StringComparison.OrdinalIgnoreCase))
				{
					ini.Elevated = true;
				}
				else if (string.Equals(text, "--machine", StringComparison.OrdinalIgnoreCase))
				{
					ini.Machine = true;
				}
				else if (string.Equals(text, "--user", StringComparison.OrdinalIgnoreCase))
				{
					ini.Machine = false;
				}
				else if (string.Equals(text, "--no-desktop", StringComparison.OrdinalIgnoreCase))
				{
					ini.Desktop = false;
				}
				else if (string.Equals(text, "--launch", StringComparison.OrdinalIgnoreCase))
				{
					ini.Launch = true;
				}
				else if (string.Equals(text, "--layout-check", StringComparison.OrdinalIgnoreCase))
				{
					ini.LayoutCheck = true;
				}
				else if (text.StartsWith("--dir=", StringComparison.OrdinalIgnoreCase))
				{
					ini.Dir = text.Substring(6).Trim('"');
				}
				else if (text.StartsWith("--data=", StringComparison.OrdinalIgnoreCase))
				{
					ini.DataDir = text.Substring(7).Trim('"');
				}
				else if (text.StartsWith("--preview=", StringComparison.OrdinalIgnoreCase))
				{
					int preview;
					if (int.TryParse(text.Substring(10).Trim('"'), out preview))
					{
						ini.Preview = preview;
					}
				}
				else if (text.StartsWith("--shot=", StringComparison.OrdinalIgnoreCase))
				{
					ini.ShotPath = text.Substring(7).Trim('"');
				}
			}
			return ini;
		}
	}
}
