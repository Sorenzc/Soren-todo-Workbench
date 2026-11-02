using System;
using System.IO;
using System.Security.Principal;

namespace TodoWorkbenchSetup
{
	internal static class Paths
	{
		public static string DataDir
		{
			get
			{
				return Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "TodoWorkbench", "data");
			}
		}

		public static bool IsElevated
		{
			get
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
		}

		public static string DefaultDir(bool machine)
		{
			if (machine)
			{
				return Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ProgramFiles), "TodoWorkbench");
			}
			return Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "Programs", "TodoWorkbench");
		}
	}
}
