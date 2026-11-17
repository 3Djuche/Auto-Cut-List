// Tests for the add-in's own logic (SheetMetalCutList.dll), run without SolidWorks.
// Build and run with Test.cmd. They call the add-in's private helpers through reflection, so the add-in's code
// doesn't have to change to be testable; anything that needs SolidWorks itself is tested in SolidWorks.
using System;
using System.Collections.Generic;
using System.Globalization;
using System.IO;
using System.Linq;
using System.Reflection;
using System.Runtime.Serialization;
using System.Text;

static class AddInTests
{
    const BindingFlags Any = BindingFlags.Public | BindingFlags.NonPublic | BindingFlags.Static | BindingFlags.Instance;
    static Assembly addIn;
    static Type main;
    static int failures, passes;

    static int Main(string[] args)
    {
        string path = args.Length > 0 ? args[0] : Path.Combine(AppDomain.CurrentDomain.BaseDirectory, "SheetMetalCutList.dll");
        addIn = Assembly.LoadFrom(path);
        main = addIn.GetType("SheetMetalCutList.AddIn", true);
        CultureInfo.CurrentCulture = CultureInfo.InvariantCulture;

        Test("lengths are read from text with or without a unit", ParsesLengths);
        Test("a length must be a positive number", PositiveLengths);
        Test("SolidWorks' own cut-length links are recognized", NativeLengthLinks);
        Test("sizes are rounded half away from zero for every decimal place", RoundsSizes);
        Test("an exact size matches the property text SolidWorks rounded it to", ExactSizesRound);
        Test("exact thickness and flat-pattern size are picked by their rounded text", ExactSizesMatch);
        Test("a labeled item stays current while only SolidWorks' rounding differs", BasisTolerance);
        Test("a labeled item is out of date when a size or its material changes", BasisChanges);
        Test("a box measured at an angle is found by the frame search", RotatedBox);
        Test("replies carry the request number and any warnings", RepliesCarryRequest);
        Test("pushes never carry a request number", PushesCarryNothing);
        Test("only Save, Apply, batch apply and presets save settings", SavingActions);

        Console.WriteLine();
        Console.WriteLine(passes + " passed, " + failures + " failed.");
        return failures == 0 ? 0 : 1;
    }

    // ---------- Tests ----------

    static void ParsesLengths()
    {
        Equal(12.5m, Call("ParseSortLength", "12.5"));
        Equal(12.5m, Call("ParseSortLength", "12.5 in"));
        Equal(300m, Call("ParseSortLength", "300mm"));
        Equal(4m, Call("ParseSortLength", "4\""));
        Equal(null, Call("ParseSortLength", "TS 2X2X1/4"));
        Equal(null, Call("ParseSortLength", ""));
    }

    static void PositiveLengths()
    {
        True((bool)CallOut("TryPositiveLength", "10.25", 0m), "10.25 is a length");
        True(!(bool)CallOut("TryPositiveLength", "0", 0m), "0 is not");
        True(!(bool)CallOut("TryPositiveLength", "-3", 0m), "-3 is not");
        True(!(bool)CallOut("TryPositiveLength", "abc", 0m), "text is not");
    }

    static void NativeLengthLinks()
    {
        True((bool)Call("IsNativeLengthExpression", "\"LENGTH@@@Cut-List-Item1@Part1.SLDPRT\""), "LENGTH link");
        True((bool)Call("IsNativeLengthExpression", "SW-Length@@@Cut-List-Item3@Frame.SLDPRT"), "SW-Length link");
        True(!(bool)Call("IsNativeLengthExpression", "40.000"), "plain text");
        True(!(bool)Call("IsNativeLengthExpression", new object[] { null }), "nothing");
    }

    static void RoundsSizes()
    {
        var options = (string[])Call("DimensionOptions", 2.5m);
        Equal("3", options[0]);
        Equal("2.50", options[2]);
        Equal("2.50000000", options[8]);
        Equal("0.13", Call("Format", 0.125m, 2));
        Equal("-0.13", Call("Format", -0.125m, 2));
    }

    static void ExactSizesRound()
    {
        var exact = NewExactSizes(0.01m);
        True(Rounds(exact, 10.125m, 10.13m), "10.125 shows as 10.13");
        True(Rounds(exact, 10.125m, 10.12m), "and is within half a step of 10.12 (binary slack)");
        True(!Rounds(exact, 10.14m, 10.12m), "10.14 doesn't show as 10.12");
    }

    static void ExactSizesMatch()
    {
        var exact = NewExactSizes(0.01m);
        Field<List<decimal>>(exact, "thicknesses").AddRange(new[] { 0.0598m, 0.1196m });
        Field<List<decimal[]>>(exact, "boxes").AddRange(new[] { new[] { 10.125m, 20.0625m }, new[] { 4.0m, 8.5m } });
        Equal(0.0598m, Invoke(exact, "Thickness", 0.06m));
        Equal(0.1196m, Invoke(exact, "Thickness", 0.12m));
        Equal(null, Invoke(exact, "Thickness", 0.25m));
        var box = (decimal[])Invoke(exact, "Box", 10.13m, 20.06m);
        True(box != null && box[0] == 10.125m && box[1] == 20.0625m, "the 10.125 x 20.0625 box");
        Equal(null, Invoke(exact, "Box", 10.13m, 21m));
    }

    static void BasisTolerance()
    {
        // Stored when labeled with an exact width; read again rounded to 0.01 in (0.000254 m).
        var labeled = NewLabel("sheet", 2, new[] { 0.0598m, 10.125m, 20m }, new decimal[3]);
        string stored = (string)Invoke(labeled, "Basis");
        var reread = NewLabel("sheet", 2, new[] { 0.0598m, 10.13m, 20m }, new[] { 0m, 0.01m, 0m });
        True((bool)Invoke(reread, "MatchesBasis", stored), "rounding alone doesn't make it out of date");
        True((bool)Invoke(labeled, "MatchesBasis", stored), "the same read matches itself");
    }

    static void BasisChanges()
    {
        var labeled = NewLabel("weldment", 1, new[] { 2m, 2m, 40m }, new decimal[3]);
        string stored = (string)Invoke(labeled, "Basis");
        True(!(bool)Invoke(NewLabel("weldment", 1, new[] { 2m, 2m, 40.5m }, new decimal[3]), "MatchesBasis", stored), "longer");
        True(!(bool)Invoke(NewLabel("weldment", 2, new[] { 2m, 2m, 40m }, new decimal[3]), "MatchesBasis", stored), "more pieces");
        var steel = NewLabel("weldment", 1, new[] { 2m, 2m, 40m }, new decimal[3]);
        SetField(steel, "Material", "AISI 304");
        True(!(bool)Invoke(steel, "MatchesBasis", stored), "other material");
        True(!(bool)Invoke(NewLabel("part", 1, new[] { 2m, 2m, 40m }, new decimal[3]), "MatchesBasis", stored), "other category");
    }

    static void RotatedBox()
    {
        // A 1 x 2 x 4 box turned 30 degrees about Z, as tessellation points.
        double angle = Math.PI / 6, c = Math.Cos(angle), s = Math.Sin(angle);
        var points = new List<float>();
        foreach (var x in new[] { 0.0, 1 }) foreach (var y in new[] { 0.0, 2 }) foreach (var z in new[] { 0.0, 4 })
            points.AddRange(new[] { (float)(x * c - y * s), (float)(x * s + y * c), (float)z });
        var axes = new[] { new[] { 1.0, 0, 0 }, new[] { 0, 1.0, 0 }, new[] { 0, 0, 1.0 } };
        var aligned = (double[])Call("PointExtents", points.ToArray(), axes);
        var frame = (double[][])Call("FrameFrom", new[] { c, s, 0 }, new[] { -s, c, 0 });
        var fitted = (double[])Call("PointExtents", points.ToArray(), frame);
        Array.Sort(fitted);
        True(Math.Abs(fitted[0] - 1) < 1e-5 && Math.Abs(fitted[1] - 2) < 1e-5 && Math.Abs(fitted[2] - 4) < 1e-5,
            "fitted 1 x 2 x 4, got " + String.Join(" x ", fitted.Select(v => v.ToString("0.#####"))));
        True((double)Call("Volume", fitted) < (double)Call("Volume", aligned), "the fitted box is smaller than the aligned one");
        True(Call("FrameFrom", new[] { 1.0, 0, 0 }, new[] { 1.0, 0, 0 }) == null, "parallel directions give no frame");
    }

    static void RepliesCarryRequest()
    {
        var session = NewSession();
        SetField(session, "RequestId", 7);
        Field<List<string>>(session, "Warnings").Add("Frame.SLDPRT was left on configuration Long.");
        Call("Reply", session, new { type = "done", message = "Exported." });
        string line = Output(session);
        True(line.StartsWith("{\"requestId\":7,\"warning\":\"Frame.SLDPRT was left on configuration Long.\",\"type\":\"done\""),
            "reply was " + line);
    }

    static void PushesCarryNothing()
    {
        var session = NewSession();
        SetField(session, "RequestId", 7);
        Call("Push", session, new { type = "parts", push = true });
        Equal("{\"type\":\"parts\",\"push\":true}", Output(session));
    }

    static void SavingActions()
    {
        foreach (var action in new[] { "save", "apply", "batchApply", "presets" })
            True((bool)Call("SavesSettings", action), action + " saves");
        foreach (var action in new[] { "refresh", "export", "exportPdf", "undo", "reorder", "selectPart", "selectConfiguration", "shapes", "batchRead" })
            True(!(bool)Call("SavesSettings", action), action + " doesn't save");
    }

    // ---------- Helpers ----------

    static void Test(string name, Action body)
    {
        try { body(); passes++; Console.WriteLine("ok      " + name); }
        catch (Exception error)
        {
            failures++;
            var inner = error is TargetInvocationException && error.InnerException != null ? error.InnerException : error;
            Console.WriteLine("FAILED  " + name + ": " + inner.Message);
        }
    }

    static void True(bool condition, string what)
    {
        if (!condition) throw new Exception(what);
    }

    static void Equal(object expected, object actual)
    {
        if (!Equals(expected, actual))
            throw new Exception("expected " + (expected ?? "null") + ", got " + (actual ?? "null"));
    }

    static MethodInfo Method(Type type, string name, int arguments)
    {
        var method = type.GetMethods(Any).FirstOrDefault(m => m.Name == name && m.GetParameters().Length == arguments);
        if (method == null) throw new Exception("the add-in has no " + name + " with " + arguments + " arguments");
        return method;
    }

    static object Call(string name, params object[] arguments)
    {
        return Method(main, name, arguments.Length).Invoke(null, arguments);
    }

    // For methods with one out parameter at the end: returns the method's result.
    static object CallOut(string name, params object[] arguments)
    {
        return Method(main, name, arguments.Length).Invoke(null, arguments);
    }

    static object Invoke(object target, string name, params object[] arguments)
    {
        return Method(target.GetType(), name, arguments.Length).Invoke(target, arguments);
    }

    static Type Nested(string name)
    {
        var type = main.GetNestedType(name, Any);
        if (type == null) throw new Exception("the add-in has no class " + name);
        return type;
    }

    static FieldInfo FieldOf(object target, string name)
    {
        var field = target.GetType().GetField(name, Any);
        if (field == null) throw new Exception(target.GetType().Name + " has no field " + name);
        return field;
    }

    static T Field<T>(object target, string name) { return (T)FieldOf(target, name).GetValue(target); }

    static void SetField(object target, string name, object value) { FieldOf(target, name).SetValue(target, value); }

    // ExactSizes reads SolidWorks in its constructor, so it's made without one and given its rounding step.
    static object NewExactSizes(decimal step)
    {
        var exact = FormatterServices.GetUninitializedObject(Nested("ExactSizes"));
        SetField(exact, "thicknesses", new List<decimal>());
        SetField(exact, "boxes", new List<decimal[]>());
        SetField(exact, "Step", step);
        return exact;
    }

    static bool Rounds(object exact, decimal value, decimal rounded) { return (bool)Invoke(exact, "Rounds", value, rounded); }

    // A measured item, in inches.
    static object NewLabel(string category, int quantity, decimal[] dimensions, decimal[] rounding)
    {
        var label = Activator.CreateInstance(Nested("Label"), true);
        SetField(label, "Category", category);
        SetField(label, "Quantity", quantity);
        SetField(label, "Dimensions", dimensions);
        SetField(label, "Rounding", rounding);
        SetField(label, "MetersPerUnit", 0.0254m);
        SetField(label, "Material", "Plain Carbon Steel");
        SetField(label, "Gauge", "");
        return label;
    }

    static object NewSession()
    {
        var session = Activator.CreateInstance(Nested("Session"), true);
        SetField(session, "Input", new StreamWriter(new MemoryStream(), new UTF8Encoding(false)) { AutoFlush = true });
        return session;
    }

    static string Output(object session)
    {
        var writer = Field<StreamWriter>(session, "Input");
        return Encoding.UTF8.GetString(((MemoryStream)writer.BaseStream).ToArray()).Trim();
    }
}
