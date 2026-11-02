using System.Reflection;

namespace TodoWorkbench
{
	internal static class AppInfo
	{
		public const string Name = "待办工作台";

		public const string AppId = "TodoWorkbench";

		public static readonly string Version = Assembly.GetExecutingAssembly().GetName().Version.ToString(3);

		public static readonly int[] Ports = new int[11]
		{
			7861, 7862, 7863, 7864, 7865, 7866, 7867, 7868, 7869, 7870,
			7871
		};
	}
}
