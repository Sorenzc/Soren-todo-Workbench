namespace TodoWorkbenchSetup
{
	/// <summary>安装包版本号。打包时 scripts/build-dist.mjs 会生成 build/out/SetupVersion.g.cs 覆盖它；
	/// 这里保留一份开发用默认值，方便直接 csc 编译调试。</summary>
	internal static class SetupVersion
	{
		public const string Value = "0.0.0-dev";
	}
}
