using System.Diagnostics;
using System.IO;

namespace TodoWorkbenchSetup
{
	internal static class Shell
	{
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
	}
}
