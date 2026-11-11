using System;
using System.Windows.Forms;

namespace TodoWorkbenchSetup
{
	internal static class Program
	{
		[STAThread]
		private static void Main(string[] args)
		{
			Application.EnableVisualStyles();
			Application.SetCompatibleTextRenderingDefault(false);
			Ini ini = Ini.Parse(args);
			SetupLog.Init();
			SetupLog.W("args=[" + string.Join(" ", args) + "] elevated=" + ini.Elevated + " machine=" + ini.Machine + " dir=" + (ini.Dir ?? "(default)") + " data=" + (ini.DataDir ?? "(default)") + " desktop=" + ini.Desktop + " launch=" + ini.Launch);
			try
			{
				if (ini.Elevated)
				{
					InstallRunner installRunner = new InstallRunner(ini, true);
					installRunner.Start();
					Application.Run(installRunner);
					SetupLog.W("silent exit=" + installRunner.Result);
					Environment.Exit(installRunner.Result);
				}
				if (ini.LayoutCheck)
				{
					// 只在开发时用：把向导每个控件的实际边界写进 setup.log，
					// 用来确认“文字被切掉 / 按钮跑出窗口”这类问题（沙箱里截不到完好的窗口图）
					SetupWizard setupWizard = new SetupWizard(ini);
					setupWizard.LayoutReport();
					Environment.Exit(0);
				}
				if (!string.IsNullOrEmpty(ini.ShotPath))
				{
					// 开发用：把向导某一页画成 PNG 再退出（不安装、不需要前台窗口）
					using (SetupWizard shot = new SetupWizard(ini))
					{
						shot.ShowPreview(ini.Preview > 0 ? ini.Preview : 1);
						shot.Show();
						Application.DoEvents();
						System.Threading.Thread.Sleep(400);
						Application.DoEvents();
						using (System.Drawing.Bitmap bmp = new System.Drawing.Bitmap(shot.Width, shot.Height))
						{
							shot.DrawToBitmap(bmp, new System.Drawing.Rectangle(0, 0, shot.Width, shot.Height));
							bmp.Save(ini.ShotPath, System.Drawing.Imaging.ImageFormat.Png);
						}
						shot.Close();
					}
					Environment.Exit(0);
				}
				if (ini.Preview > 0)
				{
					// 开发用：直接翻到第 N 页截屏核对排版（不会真的安装）
					SetupWizard preview = new SetupWizard(ini);
					preview.ShowPreview(ini.Preview);
					Application.Run(preview);
					Environment.Exit(0);
				}
				Application.Run(new SetupWizard(ini));
			}
			catch (Exception ex)
			{
				SetupLog.W("fatal " + ex);
				MessageBox.Show("安装程序出错：" + ex.Message, "待办工作台", MessageBoxButtons.OK, MessageBoxIcon.Hand);
				Environment.Exit(1);
			}
		}
	}
}
