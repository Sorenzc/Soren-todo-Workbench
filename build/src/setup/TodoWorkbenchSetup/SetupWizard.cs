using System;
using System.ComponentModel;
using System.Diagnostics;
using System.Drawing;
using System.IO;
using System.Windows.Forms;

namespace TodoWorkbenchSetup
{
	internal sealed class SetupWizard : Form
	{
		private readonly Ini ini;

		private readonly Panel page1;

		private readonly Panel page2;

		private readonly Panel page3;

		private readonly RadioButton scopeUser;

		private readonly RadioButton scopeMachine;

		private readonly TextBox dirBox;

		private readonly TextBox dataBox;

		private readonly Label hint;

		private readonly Label scopeTip;

		private readonly Label progressHead;

		private readonly Label stage;

		private readonly ProgressBar bar;

		private readonly Label donePath;

		private readonly CheckBox optLaunch;

		private readonly CheckBox optDesktop;

		private readonly CheckBox optOpenData;

		private readonly Label selfCheck;

		public SetupWizard(Ini ini)
		{
			this.ini = ini;
			Text = "安装 待办工作台";
			try
			{
				base.Icon = Icon.ExtractAssociatedIcon(Application.ExecutablePath);
			}
			catch
			{
			}
			base.StartPosition = FormStartPosition.CenterScreen;
			base.ClientSize = new Size(660, 500);
			base.FormBorderStyle = FormBorderStyle.FixedDialog;
			base.MaximizeBox = false;
			base.MinimizeBox = false;
			BackColor = Color.White;
			Font = new Font("Microsoft YaHei UI", 9.75f);
			page1 = new Panel();
			page1.Dock = DockStyle.Fill;
			page1.BackColor = Color.White;
			page1.AutoScroll = true;
			base.Controls.Add(page1);

			// 文字块一律 AutoSize + MaximumSize，按实际换行高度往下摆；
			// 不写死高度，换字体或高 DPI 时也不会互相压住。
			int y1 = 18;
			page1.Controls.Add(Place(Head("选择安装位置", 20, 620), ref y1, 0));
			page1.Controls.Add(Place(Paragraph("待办工作台是装在这台电脑上的本地程序。待办、归档和备份都存在本机，不会上传到任何服务器。", 20, 620), ref y1, 6));
			page1.Controls.Add(Place(Label2("安装给谁", 20, true), ref y1, 14));

			scopeUser = Radio("仅为我安装（推荐）", 20, 620);
			scopeUser.Checked = true;
			scopeUser.CheckedChanged += delegate
			{
				SyncScope();
			};
			page1.Controls.Add(Place(scopeUser, ref y1, 4));
			page1.Controls.Add(Place(Paragraph("装进你的用户目录，不需要管理员权限，也不会弹「用户账户控制」。只有当前 Windows 账户能用。", 42, 596), ref y1, 2));

			scopeMachine = Radio("为所有用户安装", 20, 620);
			scopeMachine.CheckedChanged += delegate
			{
				SyncScope();
			};
			page1.Controls.Add(Place(scopeMachine, ref y1, 12));
			page1.Controls.Add(Place(Paragraph("装进 Program Files，这台电脑上每个账户都能用。需要管理员权限，安装时会弹一次「用户账户控制」。", 42, 596), ref y1, 2));

			scopeTip = Paragraph("", 20, 620);
			scopeTip.ForeColor = Color.FromArgb(37, 99, 235);
			Reserve(scopeTip, 2);
			page1.Controls.Add(Place(scopeTip, ref y1, 8));

			page1.Controls.Add(Place(Label2("安装到", 20, true), ref y1, 10));

			dirBox = new TextBox();
			dirBox.Bounds = new Rectangle(20, y1 + 6, 520, 26);
			dirBox.Text = ini.Dir ?? Paths.DefaultDir(false);
			page1.Controls.Add(dirBox);
			Button button = new Button();
			button.Text = "浏览…";
			button.Bounds = new Rectangle(548, dirBox.Top, 92, 26);
			button.FlatStyle = FlatStyle.Flat;
			button.FlatAppearance.BorderColor = Color.FromArgb(209, 213, 219);
			button.Click += delegate
			{
				Browse();
			};
			page1.Controls.Add(button);
			y1 = dirBox.Bottom;

			page1.Controls.Add(Place(Paragraph("默认位置不在 C 盘也不影响使用；也可以装到任何有写权限的文件夹。", 20, 620), ref y1, 8));

			page1.Controls.Add(Place(Label2("数据存到", 20, true), ref y1, 10));
			dataBox = new TextBox();
			dataBox.Bounds = new Rectangle(20, y1 + 6, 520, 26);
			dataBox.Text = ini.DataDir ?? Paths.DataDir;
			page1.Controls.Add(dataBox);
			Button dataBrowse = new Button();
			dataBrowse.Text = "浏览…";
			dataBrowse.Bounds = new Rectangle(548, dataBox.Top, 92, 26);
			dataBrowse.FlatStyle = FlatStyle.Flat;
			dataBrowse.FlatAppearance.BorderColor = Color.FromArgb(209, 213, 219);
			dataBrowse.Click += delegate
			{
				BrowseInto(dataBox, "选择数据存放文件夹");
			};
			page1.Controls.Add(dataBrowse);
			y1 = dataBox.Bottom;

			page1.Controls.Add(Place(Paragraph("待办、速记、归档和备份都放这里；卸载时可选保留，装好后也能在「设置」里改。", 20, 620, Color.FromArgb(107, 114, 128), 8.75f), ref y1, 8));

			hint = Paragraph("", 20, 620);
			hint.ForeColor = Color.FromArgb(185, 28, 28);
			Reserve(hint, 2);
			page1.Controls.Add(Place(hint, ref y1, 8));

			Button button2 = Button2("取消", 470, 448);
			button2.Anchor = AnchorStyles.Bottom | AnchorStyles.Right;
			button2.Click += delegate
			{
				Close();
			};
			page1.Controls.Add(button2);
			Button button3 = Button2("安装", 558, 448);
			button3.Anchor = AnchorStyles.Bottom | AnchorStyles.Right;
			button3.BackColor = Color.FromArgb(37, 99, 235);
			button3.ForeColor = Color.White;
			button3.FlatAppearance.BorderSize = 0;
			button3.Click += delegate
			{
				StartInstall();
			};
			page1.Controls.Add(button3);
			page2 = new Panel();
			page2.Dock = DockStyle.Fill;
			page2.BackColor = Color.White;
			page2.Visible = false;
			base.Controls.Add(page2);
			int y2 = 18;
			page2.Controls.Add(Place(Head("正在安装", 20, 580), ref y2, 0));
			progressHead = Paragraph("正在复制程序文件…", 20, 580);
			page2.Controls.Add(Place(progressHead, ref y2, 8));
			bar = new ProgressBar();
			bar.Bounds = new Rectangle(20, y2 + 12, 620, 18);
			bar.Minimum = 0;
			bar.Maximum = 100;
			page2.Controls.Add(bar);
			stage = new Label();
			stage.Bounds = new Rectangle(20, bar.Bottom + 14, 620, 190);
			stage.Font = new Font("Microsoft YaHei UI", 9.5f);
			stage.ForeColor = Color.FromArgb(55, 65, 81);
			page2.Controls.Add(stage);
			y2 = stage.Bottom;
			page2.Controls.Add(Place(Paragraph("会做的：新建程序文件夹、在开始菜单放一个「待办工作台」、在「设置 → 应用」里登记以便卸载。\r\n不会做的：不改系统设置、不装驱动、不联网上传数据（程序只监听本机 127.0.0.1）。", 20, 620, Color.FromArgb(107, 114, 128), 8.75f), ref y2, 12));

			page3 = new Panel();
			page3.Dock = DockStyle.Fill;
			page3.BackColor = Color.White;
			page3.Visible = false;
			base.Controls.Add(page3);
			int y3 = 18;
			page3.Controls.Add(Place(Head("✓  安装完成", 20, 620), ref y3, 0));
			donePath = Paragraph("待办工作台 " + SetupVersion.Value + " 已装到\r\n" + (ini.Dir ?? Paths.DefaultDir(false)), 20, 620);
			Reserve(donePath, 3);
			page3.Controls.Add(Place(donePath, ref y3, 10));
			optLaunch = Option("立即启动待办工作台", 20, true);
			page3.Controls.Add(Place(optLaunch, ref y3, 12));
			optDesktop = Option("在桌面创建快捷方式", 20, true);
			page3.Controls.Add(Place(optDesktop, ref y3, 4));
			optOpenData = Option("打开数据目录", 20, false);
			page3.Controls.Add(Place(optOpenData, ref y3, 4));
			page3.Controls.Add(Place(Paragraph("以后可以从托盘图标随时打开，卸载时可以选择保留数据。", 20, 620, Color.FromArgb(107, 114, 128), 8.75f), ref y3, 10));
			selfCheck = Paragraph("", 20, 620);
			Reserve(selfCheck, 3);
			page3.Controls.Add(Place(selfCheck, ref y3, 10));
			Button button4 = Button2("完成", 558, 448);
			button4.Anchor = AnchorStyles.Bottom | AnchorStyles.Right;
			button4.BackColor = Color.FromArgb(37, 99, 235);
			button4.ForeColor = Color.White;
			button4.FlatAppearance.BorderSize = 0;
			button4.Click += delegate
			{
				Finish();
			};
			page3.Controls.Add(button4);
			SyncScope();
		}

		/// <summary>开发用：直接翻到某一页，方便截图核对排版（--preview=1|2|3）。</summary>
		public void ShowPreview(int page)
		{
			page1.Visible = (page == 1);
			page2.Visible = (page == 2);
			page3.Visible = (page == 3);
			if (page == 2)
			{
				progressHead.Text = "正在复制程序文件…（第 2 步，共 3 步）";
				stage.Text = "正在解压程序文件…\r\n正在创建开始菜单快捷方式…\r\n正在登记卸载信息…";
				bar.Value = 60;
			}
			if (page == 3)
			{
				donePath.Text = "待办工作台 " + SetupVersion.Value + " 已装到\r\n" + (ini.Dir ?? Paths.DefaultDir(false));
				selfCheck.Text = "自检通过：程序文件齐全，可以正常启动。";
				selfCheck.ForeColor = Color.FromArgb(4, 120, 87);
			}
		}

		public void LayoutReport()
		{
			SetupLog.W("layout: client=" + base.ClientSize.Width + "x" + base.ClientSize.Height);
			Panel[] pages = new Panel[3] { page1, page2, page3 };
			for (int i = 0; i < pages.Length; i++)
			{
				SetupLog.W("layout: page" + (i + 1) + " size=" + pages[i].Width + "x" + pages[i].Height + " controls=" + pages[i].Controls.Count);
				foreach (Control control in pages[i].Controls)
				{
					int right = control.Left + control.Width;
					int bottom = control.Top + control.Height;
					string text = (control.Text ?? "").Replace("\r", " ").Replace("\n", " ");
					if (text.Length > 28)
					{
						text = text.Substring(0, 28) + "…";
					}
					string flag = (right > pages[i].Width || bottom > pages[i].Height) ? "  OVERFLOW" : "";
					SetupLog.W("layout:   " + control.GetType().Name + " [" + text + "] " + control.Left + "," + control.Top + " " + control.Width + "x" + control.Height + flag);
				}
			}
		}

		/// <summary>按给定宽度量出文字实际高度。AutoSize + MaximumSize 在控件拿到句柄前
		/// 有时算不出换行高度（会被压扁成一行），所以这里直接量。</summary>
		private static int TextHeight(string text, Font font, int width)
		{
			if (string.IsNullOrEmpty(text))
			{
				return font.Height;
			}
			int total = 0;
			foreach (string line in text.Replace("\r\n", "\n").Split('\n'))
			{
				string probe = line.Length == 0 ? " " : line;
				Size size = TextRenderer.MeasureText(probe, font, new Size(width, 1 << 20),
					TextFormatFlags.WordBreak | TextFormatFlags.NoPadding);
				total += size.Height;
			}
			return Math.Max(font.Height, total + 2);
		}

		/// <summary>给运行期才会填文字的位置预留高度（例如提示、自检结果）。</summary>
		private static void Reserve(Label label, int lines)
		{
			label.Height = label.Font.Height * lines + 4;
		}

		/// <summary>把控件按「上一块的底边 + 间距」往下摆，返回它的底边。</summary>
		private static T Place<T>(T control, ref int y, int gap) where T : Control
		{
			control.Top = y + gap;
			y = control.Bottom;
			return control;
		}

		private static Label Head(string text, int x, int w)
		{
			Label label = new Label();
			label.Text = text;
			label.Font = new Font("Microsoft YaHei UI", 14f, FontStyle.Bold);
			label.ForeColor = Color.FromArgb(17, 24, 39);
			label.AutoSize = false;
			label.Bounds = new Rectangle(x, 0, w, TextHeight(text, label.Font, w));
			return label;
		}

		private static Label Label2(string text, int x, bool bold)
		{
			Label label = new Label();
			label.Text = text;
			label.Font = new Font("Microsoft YaHei UI", 9.75f, bold ? FontStyle.Bold : FontStyle.Regular);
			label.ForeColor = Color.FromArgb(31, 41, 55);
			label.AutoSize = false;
			label.Bounds = new Rectangle(x, 0, 580, TextHeight(text, label.Font, 580));
			return label;
		}

		private static Label Paragraph(string text, int x, int w)
		{
			return Paragraph(text, x, w, Color.FromArgb(75, 85, 99), 9f);
		}

		private static Label Paragraph(string text, int x, int w, Color color, float size)
		{
			Label label = new Label();
			label.Text = text;
			label.Font = new Font("Microsoft YaHei UI", size);
			label.ForeColor = color;
			label.AutoSize = false;
			label.Bounds = new Rectangle(x, 0, w, TextHeight(text, label.Font, w));
			return label;
		}

		private static RadioButton Radio(string text, int x, int w)
		{
			RadioButton radioButton = new RadioButton();
			radioButton.Text = text;
			radioButton.Font = new Font("Microsoft YaHei UI", 9.75f, FontStyle.Bold);
			radioButton.AutoSize = false;
			radioButton.Bounds = new Rectangle(x, 0, w, 26);
			return radioButton;
		}

		private static CheckBox Option(string text, int x, bool check)
		{
			CheckBox checkBox = new CheckBox();
			checkBox.Text = text;
			checkBox.Checked = check;
			checkBox.AutoSize = false;
			checkBox.Bounds = new Rectangle(x, 0, 580, 24);
			return checkBox;
		}

		private static Button Button2(string text, int x, int y)
		{
			Button button = new Button();
			button.Text = text;
			button.Bounds = new Rectangle(x, y, 82, 32);
			button.FlatStyle = FlatStyle.Flat;
			button.FlatAppearance.BorderColor = Color.FromArgb(209, 213, 219);
			button.BackColor = Color.White;
			button.UseVisualStyleBackColor = false;
			return button;
		}

		private void SyncScope()
		{
			bool @checked = scopeMachine.Checked;
			if (dirBox.Text == Paths.DefaultDir(!@checked))
			{
				dirBox.Text = Paths.DefaultDir(@checked);
			}
			else if (dirBox.Text.Length == 0)
			{
				dirBox.Text = Paths.DefaultDir(@checked);
			}
			scopeTip.Text = (@checked ? "这台电脑上的每个账户都能用；Windows 弹出「用户账户控制」时点「是」继续。" : "");
			if (!@checked && Paths.IsElevated)
			{
				scopeTip.Text = "当前是管理员身份运行；选「仅为我安装」只装给当前账户，不影响别人。";
			}
		}

		private void Browse()
		{
			BrowseInto(dirBox, "选择安装到哪个文件夹");
		}

		private void BrowseInto(TextBox target, string description)
		{
			using (FolderBrowserDialog folderBrowserDialog = new FolderBrowserDialog())
			{
				folderBrowserDialog.Description = description;
				folderBrowserDialog.SelectedPath = target.Text;
				if (folderBrowserDialog.ShowDialog(this) == DialogResult.OK)
				{
					target.Text = folderBrowserDialog.SelectedPath;
				}
			}
		}

		/// <summary>路径校验。label 用来区分「安装位置」和「数据目录」；
		/// 注意盘符后面的冒号是合法的（C:\...），只有出现在别处才算非法字符。</summary>
		private string Validate(string label, string raw, bool needWritable)
		{
			string dir = (raw ?? "").Trim();
			if (dir.Length == 0)
			{
				return "请先填" + label + "。";
			}
			foreach (char c in dir)
			{
				if (c < ' ')
				{
					return label + "里有看不见的控制字符，换一个吧。";
				}
				if ("<>\"|?*".IndexOf(c) >= 0)
				{
					return label + "里有 Windows 不允许的字符（< > \" | ? *），换一个吧。";
				}
			}
			// 盘符形式：X:\... ；不接受 \\?\ 之类的设备路径和 UNC 共享
			if (dir.StartsWith("\\\\") || dir.StartsWith("//"))
			{
				return label + "请用本机磁盘上的文件夹（例如 D:\\待办工作台），网络路径和设备路径这次先不支持。";
			}
			if (dir.Length < 2 || !char.IsLetter(dir[0]) || dir[1] != ':')
			{
				return label + "要写完整路径，以盘符开头（例如 D:\\待办工作台），换一个吧。";
			}
			if (dir.Length == 2 || (dir.Length == 3 && (dir[2] == '\\' || dir[2] == '/')))
			{
				return "别直接放在盘符根目录，换一个文件夹。";
			}
			if (dir[2] != '\\' && dir[2] != '/')
			{
				return label + "里的冒号只能用来分隔盘符（例如 D:\\待办工作台），换一个吧。";
			}
			string rawRest = dir.Substring(3);
			if (rawRest.IndexOf(':') >= 0)
			{
				return label + "里的冒号只能用来分隔盘符（例如 D:\\待办工作台），换一个吧。";
			}
			foreach (string segment in rawRest.Split(new char[2] { '\\', '/' }, StringSplitOptions.RemoveEmptyEntries))
			{
				if (segment.EndsWith(".") || segment.EndsWith(" "))
				{
					return label + "里的文件夹名不能以空格或点结尾，换一个吧。";
				}
				if (IsReservedName(segment))
				{
					return label + "里不能用 " + segment + " 这种 Windows 保留名，换一个吧。";
				}
			}
			string fullPath;
			try
			{
				fullPath = Path.GetFullPath(dir).TrimEnd('\\', '/');
			}
			catch
			{
				return label + "看起来不是一个合法的路径，换一个吧。";
			}
			if (fullPath.Length > 180)
			{
				return label + "太长了（" + fullPath.Length + " 个字符），Windows 可能装不全。建议用默认位置。";
			}
			if (fullPath.Length <= 3)
			{
				return "别直接放在盘符根目录，换一个文件夹。";
			}
			if (File.Exists(fullPath))
			{
				return label + "上已经有一个叫 " + Path.GetFileName(fullPath) + " 的文件，不是文件夹。";
			}
			if (!needWritable)
			{
				return null;
			}
			try
			{
				string pathRoot = Path.GetPathRoot(fullPath);
				DriveInfo driveInfo = new DriveInfo(pathRoot);
				if (driveInfo.IsReady && driveInfo.AvailableFreeSpace < 419430400)
				{
					return "这个盘只剩 " + driveInfo.AvailableFreeSpace / 1048576 + " MB，安装大约需要 400 MB。";
				}
			}
			catch
			{
			}
			try
			{
				if (!Directory.Exists(fullPath))
				{
					Directory.CreateDirectory(fullPath);
				}
				string path = Path.Combine(fullPath, ".setup-probe");
				File.WriteAllText(path, "1");
				File.Delete(path);
			}
			catch (UnauthorizedAccessException)
			{
				return label + "需要管理员权限才能写。选「为所有用户安装」，或者换个位置。";
			}
			catch (Exception ex2)
			{
				return "没法往" + label + "写文件：" + ex2.Message;
			}
			return null;
		}

		/// <summary>CON / PRN / NUL 这类保留名不能当文件夹名。</summary>
		private static bool IsReservedName(string segment)
		{
			string name = segment.Split('.')[0].Trim().ToUpperInvariant();
			return name == "CON" || name == "PRN" || name == "AUX" || name == "NUL"
				|| name == "COM1" || name == "COM2" || name == "COM3" || name == "COM4"
				|| name == "LPT1" || name == "LPT2" || name == "LPT3";
		}

		private void StartInstall()
		{
			string dir = dirBox.Text.Trim().TrimEnd('\\');
			string text = Validate("安装位置", dir, true);
			if (text != null)
			{
				hint.Text = text;
				return;
			}
			string dataDir = dataBox.Text.Trim().TrimEnd('\\');
			string text2 = Validate("数据目录", dataDir, false);
			if (text2 != null)
			{
				hint.Text = text2;
				return;
			}
			hint.Text = "";
			if (dataDir.TrimEnd('\\').ToLowerInvariant() == dir.TrimEnd('\\').ToLowerInvariant())
			{
				hint.Text = "数据目录不要和安装位置用同一个文件夹，换一个吧。";
				return;
			}
			if (scopeMachine.Checked && !Paths.IsElevated)
			{
				RelaunchElevated(dir, dataDir);
			}
			else
			{
				RunInstall(scopeMachine.Checked, dir, dataDir, false);
			}
		}

		private void RelaunchElevated(string dir, string dataDir)
		{
			hint.Text = "正在请求管理员权限…";
			try
			{
				ProcessStartInfo processStartInfo = new ProcessStartInfo(Application.ExecutablePath);
				processStartInfo.Arguments = "--elevated --machine --dir=\"" + dir + "\" --data=\"" + dataDir + "\"" + (optDesktop.Checked ? "" : " --no-desktop") + (optLaunch.Checked ? " --launch" : "");
				processStartInfo.Verb = "runas";
				processStartInfo.UseShellExecute = true;
				Process process = Process.Start(processStartInfo);
				Hide();
				process.WaitForExit();
				int exitCode = process.ExitCode;
				Show();
				if (exitCode == 0)
				{
					MessageBox.Show(this, "安装完成。", "待办工作台");
					Close();
					return;
				}
				hint.Text = "已取消管理员授权，改成「仅为我安装」—— 不需要管理员权限，可以直接继续。";
				scopeMachine.Checked = false;
				scopeUser.Checked = true;
				dirBox.Text = Paths.DefaultDir(false);
			}
			catch (Win32Exception)
			{
				hint.Text = "已取消管理员授权，改成「仅为我安装」—— 不需要管理员权限，可以直接继续。";
				scopeMachine.Checked = false;
				scopeUser.Checked = true;
				dirBox.Text = Paths.DefaultDir(false);
			}
		}

		private void RunInstall(bool machine, string dir, string dataDir, bool fromElevated)
		{
			page1.Visible = false;
			page2.Visible = true;
			page2.BringToFront();
			InstallRunner runner = new InstallRunner(new Ini
			{
				Dir = dir,
				DataDir = dataDir,
				Machine = machine,
				Desktop = optDesktop.Checked
			}, false);
			runner.Progress += delegate(string text, int percent)
			{
				if (!base.IsDisposed)
				{
					progressHead.Text = text;
					if (percent >= 0)
					{
						bar.Style = ProgressBarStyle.Continuous;
						bar.Value = Math.Max(0, Math.Min(100, percent));
					}
					else
					{
						bar.Style = ProgressBarStyle.Marquee;
					}
				}
			};
			runner.Stage += delegate(string text)
			{
				if (!base.IsDisposed)
				{
					stage.Text = text;
				}
			};
			runner.Done += delegate(int code, string message)
			{
				if (!base.IsDisposed)
				{
					if (code != 0)
					{
						page2.Visible = false;
						page1.Visible = true;
						page1.BringToFront();
						hint.Text = "安装没有完成：" + message;
					}
					else
					{
						donePath.Text = "待办工作台 " + SetupVersion.Value + " 已装到\r\n" + dir;
						page2.Visible = false;
						page3.Visible = true;
						page3.BringToFront();
						selfCheck.Text = runner.SelfCheckMessage;
						selfCheck.ForeColor = (runner.SelfCheckOk ? Color.FromArgb(4, 120, 87) : Color.FromArgb(180, 83, 9));
					}
				}
			};
			runner.Start();
		}

		private void Finish()
		{
			string text = dirBox.Text.Trim().TrimEnd('\\');
			string text2 = Path.Combine(text, "待办工作台.exe");
			if (optDesktop.Checked)
			{
				Shortcuts.CreateDesktop(text2, text);
			}
			if (optOpenData.Checked)
			{
				Shell.OpenFolder(Paths.DataDir);
			}
			if (optLaunch.Checked)
			{
				try
				{
					ProcessStartInfo processStartInfo = new ProcessStartInfo(text2);
					processStartInfo.UseShellExecute = true;
					processStartInfo.WorkingDirectory = text;
					Process.Start(processStartInfo);
				}
				catch (Exception ex)
				{
					MessageBox.Show(this, "启动失败：" + ex.Message, "待办工作台");
				}
			}
			Close();
		}
	}
}
