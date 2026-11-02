using System;
using System.Drawing;
using System.Windows.Forms;

namespace TodoWorkbench
{
	internal sealed class StatusForm : Form
	{
		private readonly Label title;

		private readonly Label status;

		private readonly ProgressBar bar;

		private readonly LinkLabel stuck;

		public event Action OnStuck;

		public StatusForm()
		{
			Text = "待办工作台";
			base.FormBorderStyle = FormBorderStyle.None;
			base.StartPosition = FormStartPosition.CenterScreen;
			base.ClientSize = new Size(430, 172);
			BackColor = Color.White;
			base.ShowInTaskbar = false;
			base.TopMost = true;
			Panel value = new Panel
			{
				BackColor = Color.FromArgb(37, 99, 235),
				Bounds = new Rectangle(0, 0, 6, base.ClientSize.Height)
			};
			base.Controls.Add(value);
			title = new Label();
			title.Text = "待办工作台";
			title.Font = new Font("Microsoft YaHei UI", 13f, FontStyle.Bold);
			title.ForeColor = Color.FromArgb(17, 24, 39);
			title.Bounds = new Rectangle(28, 24, 380, 28);
			base.Controls.Add(title);
			status = new Label();
			status.Text = "正在启动…";
			status.Font = new Font("Microsoft YaHei UI", 9.75f);
			status.ForeColor = Color.FromArgb(75, 85, 99);
			status.Bounds = new Rectangle(28, 60, 380, 44);
			base.Controls.Add(status);
			bar = new ProgressBar();
			bar.Style = ProgressBarStyle.Marquee;
			bar.MarqueeAnimationSpeed = 28;
			bar.Bounds = new Rectangle(28, 112, 374, 6);
			base.Controls.Add(bar);
			stuck = new LinkLabel();
			stuck.Text = "没反应？点这里";
			stuck.Font = new Font("Microsoft YaHei UI", 9f);
			stuck.LinkColor = Color.FromArgb(37, 99, 235);
			stuck.Bounds = new Rectangle(28, 130, 160, 22);
			stuck.Visible = false;
			LinkLabel linkLabel = stuck;
			LinkLabelLinkClickedEventHandler value2 = delegate
			{
				if (this.OnStuck != null)
				{
					this.OnStuck();
				}
			};
			linkLabel.LinkClicked += value2;
			base.Controls.Add(stuck);
		}

		public void SetStatus(string text)
		{
			if (!base.IsDisposed)
			{
				status.Text = text;
			}
		}

		public void SetStuck(bool visible)
		{
			if (!base.IsDisposed)
			{
				stuck.Visible = visible;
			}
		}
	}
}
