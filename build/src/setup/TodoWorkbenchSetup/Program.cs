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
