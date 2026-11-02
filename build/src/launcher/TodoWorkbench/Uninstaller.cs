using System;
using System.Diagnostics;
using System.IO;
using System.Reflection;
using Microsoft.Win32;

namespace TodoWorkbench
{
	internal static class Uninstaller
	{
		public static bool Purge(string exeDir, string dataDir, bool dropData)
		{
			try
			{
				Program.StopServer();
				RemoveShortcuts();
				RemoveRegistry();
				ScheduleDirRemoval(exeDir);
				if (dropData)
				{
					try
					{
						if (Directory.Exists(dataDir))
						{
							Directory.Delete(dataDir, true);
						}
					}
					catch (Exception ex)
					{
						Program.Log("delete data failed " + ex.Message);
					}
				}
				Program.Log("uninstalled exeDir=" + exeDir + " dropData=" + dropData);
				return true;
			}
			catch (Exception ex2)
			{
				Program.Log("uninstall failed " + ex2);
				return false;
			}
		}

		private static void RemoveShortcuts()
		{
			string folderPath = Environment.GetFolderPath(Environment.SpecialFolder.DesktopDirectory);
			string folderPath2 = Environment.GetFolderPath(Environment.SpecialFolder.Programs);
			string[] array = new string[3]
			{
				Path.Combine(folderPath, "待办工作台.lnk"),
				Path.Combine(folderPath2, "待办工作台.lnk"),
				Path.Combine(folderPath2, "待办工作台（不自动开浏览器）.lnk")
			};
			string[] array2 = array;
			string[] array3 = array2;
			foreach (string path in array3)
			{
				try
				{
					if (File.Exists(path))
					{
						File.Delete(path);
					}
				}
				catch
				{
				}
			}
			try
			{
				string path2 = Path.Combine(folderPath2, "待办工作台");
				if (Directory.Exists(path2))
				{
					Directory.Delete(path2, true);
				}
			}
			catch
			{
			}
		}

		private static void RemoveRegistry()
		{
			try
			{
				Registry.CurrentUser.DeleteSubKeyTree("Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\TodoWorkbench", false);
			}
			catch
			{
			}
			try
			{
				using (RegistryKey registryKey = RegistryKey.OpenBaseKey(RegistryHive.LocalMachine, RegistryView.Registry64))
				{
					registryKey.DeleteSubKeyTree("Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\TodoWorkbench", false);
				}
			}
			catch
			{
			}
		}

		private static void ScheduleDirRemoval(string exeDir)
		{
			string location = Assembly.GetExecutingAssembly().Location;
			string[] files = Directory.GetFiles(exeDir, "*", SearchOption.AllDirectories);
			string[] array = files;
			foreach (string text in array)
			{
				if (!string.Equals(text, location, StringComparison.OrdinalIgnoreCase))
				{
					try
					{
						File.Delete(text);
					}
					catch
					{
					}
				}
			}
			string[] directories = Directory.GetDirectories(exeDir, "*", SearchOption.AllDirectories);
			string[] array2 = directories;
			foreach (string path in array2)
			{
				try
				{
					if (Directory.GetFileSystemEntries(path).Length == 0)
					{
						Directory.Delete(path, true);
					}
				}
				catch
				{
				}
			}
			try
			{
				ProcessStartInfo processStartInfo = new ProcessStartInfo("cmd.exe", "/c ping 127.0.0.1 -n 3 >nul & del /f /q \"" + location + "\" & rmdir /s /q \"" + exeDir + "\"");
				processStartInfo.UseShellExecute = false;
				processStartInfo.CreateNoWindow = true;
				Process.Start(processStartInfo);
			}
			catch (Exception ex)
			{
				Program.Log("schedule dir removal failed " + ex.Message);
			}
		}
	}
}
