using System;
using System.Diagnostics;
using System.Drawing;
using System.IO;
using System.Reflection;
using System.Windows.Forms;
using Microsoft.Win32;

namespace TodoWorkbench
{
	internal sealed class UninstallForm : Form
	{
		private readonly string exeDir;

		private readonly string dataDir;

		private readonly RadioButton keep;

		private readonly RadioButton drop;

		public UninstallForm(string exeDir, string dataDir)
		{
			this.exeDir = exeDir;
			this.dataDir = dataDir;
			Text = "卸载 待办工作台";
			try
			{
				base.Icon = Icon.ExtractAssociatedIcon(Application.ExecutablePath);
			}
			catch
			{
			}
			base.StartPosition = FormStartPosition.CenterScreen;
			base.ClientSize = new Size(540, 366);
			base.FormBorderStyle = FormBorderStyle.FixedDialog;
			base.MaximizeBox = false;
			base.MinimizeBox = false;
			BackColor = Color.White;
			Font = new Font("Microsoft YaHei UI", 9.75f);
			Label value = new Label
			{
				Text = "卸载 待办工作台",
				Font = new Font("Microsoft YaHei UI", 13f, FontStyle.Bold),
				Bounds = new Rectangle(20, 18, 500, 30)
			};
			base.Controls.Add(value);
			Label value2 = new Label
			{
				Text = "会删除：程序文件、开始菜单和桌面快捷方式、卸载登记。\r\n不会动：你的文档、其他软件。",
				ForeColor = Color.FromArgb(55, 65, 81),
				Bounds = new Rectangle(20, 56, 500, 44)
			};
			base.Controls.Add(value2);
			Label value3 = new Label
			{
				Text = "你的待办数据在：\r\n" + dataDir + "\r\n" + DescribeData(dataDir),
				ForeColor = Color.FromArgb(107, 114, 128),
				Bounds = new Rectangle(20, 106, 500, 60)
			};
			base.Controls.Add(value3);
			keep = new RadioButton();
			keep.Text = "保留我的数据（推荐）—— 重新安装后自动接着用";
			keep.Checked = true;
			keep.Bounds = new Rectangle(20, 178, 490, 24);
			base.Controls.Add(keep);
			drop = new RadioButton();
			drop.Text = "删除我的数据 —— 待办、归档、备份全部永久删除";
			drop.Bounds = new Rectangle(20, 206, 490, 24);
			RadioButton radioButton = drop;
			EventHandler value4 = delegate
			{
				if (drop.Checked && MessageBox.Show(this, "确定删除全部数据？\r\n待办、归档 md、备份都会被永久删除，无法恢复。\r\n\r\n建议先导出备份。", "删除数据", MessageBoxButtons.OKCancel, MessageBoxIcon.Exclamation) != DialogResult.OK)
				{
					drop.Checked = false;
					keep.Checked = true;
				}
			};
			radioButton.CheckedChanged += value4;
			base.Controls.Add(drop);
			Button button = new Button();
			button.Text = "卸载";
			button.Bounds = new Rectangle(360, 300, 76, 32);
			button.BackColor = Color.FromArgb(185, 28, 28);
			button.ForeColor = Color.White;
			button.FlatStyle = FlatStyle.Flat;
			button.FlatAppearance.BorderSize = 0;
			button.Click += delegate
			{
				DoUninstall();
			};
			base.Controls.Add(button);
			Button button2 = new Button();
			button2.Text = "取消";
			button2.Bounds = new Rectangle(444, 300, 76, 32);
			button2.FlatStyle = FlatStyle.Flat;
			button2.FlatAppearance.BorderColor = Color.FromArgb(209, 213, 219);
			button2.Click += delegate
			{
				Close();
			};
			base.Controls.Add(button2);
		}

		private static string DescribeData(string dir)
		{
			try
			{
				if (!Directory.Exists(dir))
				{
					return "（这个文件夹现在不存在）";
				}
				string[] files = Directory.GetFiles(dir, "*", SearchOption.AllDirectories);
				long num = 0L;
				int num2 = 0;
				string[] array = files;
				string[] array2 = array;
				foreach (string text in array2)
				{
					try
					{
						num += new FileInfo(text).Length;
					}
					catch
					{
					}
					if (text.EndsWith(".md", StringComparison.OrdinalIgnoreCase))
					{
						num2++;
					}
				}
				return files.Length + " 个文件，其中 " + num2 + " 个归档 md，共 " + ((double)num / 1048576.0).ToString("0.0") + " MB";
			}
			catch
			{
				return "";
			}
		}

		private void DoUninstall()
		{
			Cursor = Cursors.WaitCursor;
			try
			{
				bool flag = !drop.Checked;
				Uninstaller.Purge(exeDir, dataDir, !flag);
				Cursor = Cursors.Default;
				if (!flag)
				{
					MessageBox.Show(this, "已卸载，数据已删除。", "待办工作台");
				}
				else
				{
					MessageBox.Show(this, "已卸载。\r\n数据还留在：\r\n" + dataDir + "\r\n不再需要的话可以手动删掉这个文件夹。", "待办工作台");
				}
				Close();
			}
			catch (Exception ex)
			{
				Cursor = Cursors.Default;
				MessageBox.Show(this, "卸载没有完成：" + ex.Message + "\r\n日志：" + Program.LogFile, "待办工作台", MessageBoxButtons.OK, MessageBoxIcon.Exclamation);
			}
		}

		private void RemoveShortcuts()
		{
			string[] array = new string[3]
			{
				Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.DesktopDirectory), "待办工作台.lnk"),
				Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.Programs), "待办工作台.lnk"),
				Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.Programs), "待办工作台", "待办工作台.lnk")
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
				string path2 = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.Programs), "待办工作台");
				if (Directory.Exists(path2))
				{
					Directory.Delete(path2, true);
				}
			}
			catch
			{
			}
		}

		private void RemoveRegistry()
		{
			string[] array = new string[2] { "Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\TodoWorkbench", "Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\TodoWorkbench-peruser" };
			string[] array2 = array;
			string[] array3 = array2;
			foreach (string subkey in array3)
			{
				try
				{
					Registry.CurrentUser.DeleteSubKeyTree(subkey, false);
				}
				catch
				{
				}
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

		private void DeleteInstallDir()
		{
			try
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
						if (Directory.GetFiles(path).Length == 0)
						{
							Directory.Delete(path, true);
						}
					}
					catch
					{
					}
				}
				Path.GetFileName(location);
				ProcessStartInfo processStartInfo = new ProcessStartInfo("cmd.exe", "/c ping 127.0.0.1 -n 3 >nul & del /f /q \"" + location + "\" & rmdir /s /q \"" + exeDir + "\"");
				processStartInfo.UseShellExecute = false;
				processStartInfo.CreateNoWindow = true;
				Process.Start(processStartInfo);
			}
			catch (Exception ex)
			{
				Program.Log("delete install dir failed " + ex.Message);
			}
		}
	}
}
