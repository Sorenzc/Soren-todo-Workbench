using System;
using System.Drawing;
using System.Windows.Forms;

namespace TodoWorkbench
{
	internal sealed class ErrorPanel : Form
	{
		public ErrorPanel(string headline, string why, string url, string dataDir)
		{
			ErrorPanel errorPanel = this;
			Text = "待办工作台";
			try
			{
				base.Icon = Icon.ExtractAssociatedIcon(Application.ExecutablePath);
			}
			catch
			{
			}
			base.StartPosition = FormStartPosition.CenterScreen;
			base.ClientSize = new Size(560, 452);
			MinimumSize = new Size(560, 452);
			base.MaximizeBox = false;
			base.MinimizeBox = false;
			BackColor = Color.White;
			Font = new Font("Microsoft YaHei UI", 9.75f);
			Label value = new Label
			{
				Text = "⚠  " + headline,
				Font = new Font("Microsoft YaHei UI", 12.5f, FontStyle.Bold),
				ForeColor = Color.FromArgb(180, 83, 9),
				Bounds = new Rectangle(20, 18, 520, 30)
			};
			base.Controls.Add(value);
			Label value2 = new Label
			{
				Text = why + "\r\n\r\n工作台已经在后台运行，你的待办没有丢，数据就在下面这个文件夹里。",
				Bounds = new Rectangle(20, 54, 520, 72),
				ForeColor = Color.FromArgb(55, 65, 81)
			};
			base.Controls.Add(value2);
			string value3 = url;
			Action action = delegate
			{
				Copy(url);
			};
			AddRow("本地地址", value3, 136, 74, action);
			AddRow("数据目录", dataDir, 174, 300, delegate
			{
				Program.OpenFolder(dataDir);
			});
			Button button = MakeButton("再次打开浏览器", 20, 224, 140, true);
			button.Click += delegate
			{
				bool flag = Program.OpenBrowser(url);
				MessageBox.Show(this, flag ? "已把浏览器叫起来了。" : "还是没起来。点「复制地址」，粘到浏览器地址栏（Edge / Chrome 都行）里打开。", "待办工作台");
			};
			base.Controls.Add(button);
			Button button2 = MakeButton("复制地址", 168, 224, 96, false);
			button2.Click += delegate
			{
				Copy(url);
			};
			base.Controls.Add(button2);
			Button button3 = MakeButton("打开数据目录", 272, 224, 118, false);
			button3.Click += delegate
			{
				Program.OpenFolder(dataDir);
			};
			base.Controls.Add(button3);
			Button button4 = MakeButton("停止服务", 398, 224, 96, false);
			button4.Click += delegate
			{
				if (MessageBox.Show(this, "停止后界面会打不开，待办数据不会被删除。\r\n下次双击图标会重新启动。", "停止待办工作台？", MessageBoxButtons.OKCancel, MessageBoxIcon.Question) == DialogResult.OK)
				{
					Program.StopServer();
					MessageBox.Show(this, "已停止本地服务。", "待办工作台");
				}
			};
			base.Controls.Add(button4);
			Button button5 = MakeButton("查看日志", 20, 268, 96, false);
			button5.Click += delegate
			{
				ShowLogs();
			};
			base.Controls.Add(button5);
			Label label = new Label();
			label.Text = "▸ 诊断信息（错误码 " + ErrorCodes.Current + "，复制给维护的人）";
			label.ForeColor = Color.FromArgb(107, 114, 128);
			label.Bounds = new Rectangle(124, 272, 400, 20);
			label.Cursor = Cursors.Hand;
			label.Click += delegate
			{
				ShowLogs();
			};
			base.Controls.Add(label);
			TextBox value4 = new TextBox
			{
				Multiline = true,
				ReadOnly = true,
				ScrollBars = ScrollBars.Vertical,
				Font = new Font("Consolas", 8.5f),
				Bounds = new Rectangle(20, 300, 520, 96),
				Text = Program.LogTail(14)
			};
			base.Controls.Add(value4);
			Button button6 = MakeButton("关闭", 464, 408, 76, false);
			button6.Click += delegate
			{
				Close();
			};
			base.Controls.Add(button6);
		}

		private void AddRow(string label, string value, int top, int boxWidth, Action action)
		{
			Label label2 = new Label();
			label2.Text = label;
			label2.ForeColor = Color.FromArgb(107, 114, 128);
			label2.Bounds = new Rectangle(20, top, 70, 22);
			base.Controls.Add(label2);
			TextBox textBox = new TextBox();
			textBox.ReadOnly = true;
			textBox.BorderStyle = BorderStyle.FixedSingle;
			textBox.Text = value;
			textBox.Bounds = new Rectangle(92, top - 2, boxWidth, 24);
			textBox.BackColor = Color.FromArgb(249, 250, 251);
			base.Controls.Add(textBox);
			Button button = MakeButton((label == "本地地址") ? "复制" : "打开", 92 + boxWidth + 8, top - 2, 56, false);
			button.Click += delegate
			{
				action();
			};
			base.Controls.Add(button);
		}

		private static Button MakeButton(string text, int x, int y, int w, bool primary)
		{
			Button button = new Button();
			button.Text = text;
			button.Bounds = new Rectangle(x, y, w, 30);
			button.FlatStyle = FlatStyle.Flat;
			if (primary)
			{
				button.BackColor = Color.FromArgb(37, 99, 235);
				button.ForeColor = Color.White;
				button.FlatAppearance.BorderSize = 0;
			}
			else
			{
				button.BackColor = Color.White;
				button.ForeColor = Color.FromArgb(31, 41, 55);
				button.FlatAppearance.BorderColor = Color.FromArgb(209, 213, 219);
			}
			button.UseVisualStyleBackColor = false;
			return button;
		}

		private void Copy(string url)
		{
			Program.CopyText(url);
			MessageBox.Show(this, "已复制 " + url + "\r\n粘到浏览器地址栏回车即可。", "待办工作台");
		}

		private void ShowLogs()
		{
			string text = Program.LogTail(40);
			Form form = new Form();
			form.Text = "诊断信息 · 待办工作台";
			form.StartPosition = FormStartPosition.CenterParent;
			form.ClientSize = new Size(720, 460);
			TextBox t = new TextBox();
			t.Multiline = true;
			t.ReadOnly = true;
			t.ScrollBars = ScrollBars.Both;
			t.WordWrap = false;
			t.Font = new Font("Consolas", 9f);
			t.Dock = DockStyle.Fill;
			t.Text = "错误码：" + ErrorCodes.Current + "\r\n\r\n" + text;
			form.Controls.Add(t);
			Button button = new Button();
			button.Text = "复制";
			button.Dock = DockStyle.Bottom;
			button.Height = 32;
			button.Click += delegate
			{
				Program.CopyText(t.Text);
			};
			form.Controls.Add(button);
			form.ShowDialog(this);
		}
	}
}
