using System;
using System.Collections.Generic;
using System.Globalization;
using System.IO;
using System.Linq;
using System.Runtime.InteropServices;

namespace SheetMetalCutList
{
    public sealed partial class AddIn
    {
        // Asks where to save an Excel workbook or (pdf) a PDF. Null if the user cancels.
        private static string AskExportPath(bool pdf, IntPtr owner)
        {
            using (var dialog = new System.Windows.Forms.SaveFileDialog {
                Filter = pdf ? "PDF document (*.pdf)|*.pdf" : "Excel workbook (*.xlsx)|*.xlsx", DefaultExt = pdf ? "pdf" : "xlsx",
                AddExtension = true, OverwritePrompt = true, FileName = pdf ? "Cut List.pdf" : "Cut List.xlsx"
            })
            {
                var result = owner == IntPtr.Zero ? dialog.ShowDialog() : dialog.ShowDialog(new OwnerWindow(owner));
                return result == System.Windows.Forms.DialogResult.OK ? dialog.FileName : null;
            }
        }

        // Writes the cut list as an Excel workbook, or (pdf) as a PDF that Excel prints from the same workbook.
        private static void WriteExport(string path, List<Label> labels, string[] thumbnails, bool pdf, bool metric)
        {
            var started = DateTime.Now.AddSeconds(-2);
            try
            {
                WriteExcel(path, labels, thumbnails, pdf, metric);
            }
            catch (COMException)
            {
                // Excel can report a disconnected object while closing, after the workbook is saved.
                // Only treat it as a failure if the file was not written.
                if (!File.Exists(path) || File.GetLastWriteTime(path) < started) throw;
            }
            finally
            {
                // Release every Excel object (cells, ranges, shapes) so EXCEL.EXE exits.
                GC.Collect();
                GC.WaitForPendingFinalizers();
                GC.Collect();
                GC.WaitForPendingFinalizers();
            }
        }

        private static void WriteExcel(string path, List<Label> labels, string[] thumbnails, bool pdf, bool metric)
        {
            var excelType = Type.GetTypeFromProgID("Excel.Application");
            if (excelType == null)
                throw new InvalidOperationException("Microsoft Excel is required for " + (pdf ? "the PDF" : "this") + " export.");
            dynamic excel = Activator.CreateInstance(excelType);
            dynamic book = null;
            var pictures = new List<string>();
            try
            {
                excel.DisplayAlerts = false;
                book = excel.Workbooks.Add(-4167);
                dynamic sheet = book.Worksheets[1];
                sheet.Name = "Cut list";
                var cells = new object[labels.Count + 1, 7];
                var headers = new[] { "Body", "Cut-list item", "Category", "Quantity", "Description", "Length", "Length basis" };
                for (int column = 0; column < headers.Length; column++) cells[0, column] = headers[column];
                for (int i = 0; i < labels.Count; i++)
                {
                    var label = labels[i];
                    cells[i + 1, 1] = label.Name;
                    cells[i + 1, 2] = CategoryName(label.Category, LabelSettings.HasCustom(label.Manager));
                    cells[i + 1, 3] = label.Quantity;
                    cells[i + 1, 4] = Read(label.Manager, "Description");
                    string length = Read(label.Manager, "Length");
                    cells[i + 1, 5] = length;
                    cells[i + 1, 6] = ExportLengthSource(label, length);
                }
                var columns = new[] { 22, 28, 18, 11, 40, 18, 30 };
                for (int i = 0; i < columns.Length; i++) sheet.Columns[i + 1].ColumnWidth = columns[i];
                sheet.Range["B:C"].NumberFormat = "@";
                sheet.Range["E:G"].NumberFormat = "@";
                dynamic used = sheet.Range["A1", "G" + (labels.Count + 1)];
                used.Value2 = cells;
                used.VerticalAlignment = -4108;
                used.WrapText = true;
                dynamic heading = sheet.Range["A1:G1"];
                heading.Font.Bold = true;
                heading.Font.Color = 16777215;
                heading.Interior.Color = 6693657;
                heading.RowHeight = 23;
                used.AutoFilter(1);
                sheet.Range["A2", "G" + (labels.Count + 1)].RowHeight = 70;
                for (int i = 0; thumbnails != null && i < Math.Min(thumbnails.Length, labels.Count); i++)
                {
                    if (String.IsNullOrEmpty(thumbnails[i])) continue;
                    string file = Path.Combine(Path.GetTempPath(), Guid.NewGuid().ToString("N") + ".png");
                    pictures.Add(file);
                    File.WriteAllBytes(file, Convert.FromBase64String(thumbnails[i]));
                    dynamic cell = sheet.Cells[i + 2, 1];
                    dynamic shape = sheet.Shapes.AddPicture(file, 0, -1, (float)cell.Left + 4, (float)cell.Top + 3, 102f, 64f);
                    shape.Placement = 1;
                }
                AddStockTotals(book, sheet, labels, metric);
                if (pdf)
                {
                    foreach (dynamic page in book.Worksheets) SetUpPrinting(page);
                    // 0 = xlTypePDF. Every sheet is exported: the cut list, then stock totals if there are any.
                    book.ExportAsFixedFormat(0, path);
                }
                else book.SaveAs(path, 51);
            }
            finally
            {
                // Cleanup is best effort: once the workbook is saved, Excel shutting down or a released object
                // reporting "does not exist" must not turn a good export into an error.
                try { if (book != null) book.Close(false); } catch (COMException) { }
                try { excel.Quit(); } catch (COMException) { }
                try { if (book != null) Marshal.FinalReleaseComObject(book); } catch (Exception) { }
                try { Marshal.FinalReleaseComObject(excel); } catch (Exception) { }
                foreach (var file in pictures) try { File.Delete(file); } catch (IOException) { }
            }
        }

        // Landscape, one page wide, with the heading row repeated on every page. Page setup talks to the
        // printer driver and can fail on a PC without one; the PDF is still written with Excel's defaults.
        private static void SetUpPrinting(dynamic sheet)
        {
            try
            {
                dynamic setup = sheet.PageSetup;
                setup.Orientation = 2;
                setup.Zoom = false;
                setup.FitToPagesWide = 1;
                setup.FitToPagesTall = false;
                setup.PrintTitleRows = "$1:$1";
                setup.CenterFooter = "Page &P of &N";
            }
            catch (COMException) { }
        }

        private static string CategoryName(string category, bool custom)
        {
            return custom ? "Custom" : category == "sheet" ? "Sheet Metal" : category == "weldment" ? "Weldment" : "Regular Part";
        }

        // A second sheet for purchasing: total length of each weldment profile (by its Description and material).
        private static void AddStockTotals(dynamic book, dynamic first, List<Label> labels, bool metric)
        {
            var totals = new Dictionary<string, StockTotal>();
            foreach (var label in labels)
            {
                if (label.Category != "weldment") continue;
                string profile = Read(label.Manager, "Description");
                if (String.IsNullOrWhiteSpace(profile)) profile = String.IsNullOrWhiteSpace(label.DefaultCallout) ? label.Name : label.DefaultCallout;
                string key = profile + "\n" + label.Material;
                StockTotal total;
                if (!totals.TryGetValue(key, out total))
                    totals.Add(key, total = new StockTotal { Profile = profile, Material = label.Material });
                total.Pieces += label.Quantity;
                if (label.Dimensions == null) total.Unmeasured += label.Quantity;
                else total.Length += ToUnits(label, label.Dimensions[2], metric ? "metric" : "imperial") * label.Quantity;
            }
            if (totals.Count == 0) return;

            var rows = totals.Values.OrderBy(total => total.Profile, StringComparer.CurrentCultureIgnoreCase).ToList();
            dynamic sheet = book.Worksheets.Add(Type.Missing, first);
            sheet.Name = "Stock totals";
            var headers = new[] { "Profile", "Material", "Pieces", metric ? "Total length (mm)" : "Total length (in)",
                metric ? "Total length (m)" : "Total length (ft)", "Pieces not measured" };
            var cells = new object[rows.Count + 1, headers.Length];
            for (int column = 0; column < headers.Length; column++) cells[0, column] = headers[column];
            for (int i = 0; i < rows.Count; i++)
            {
                cells[i + 1, 0] = rows[i].Profile;
                cells[i + 1, 1] = rows[i].Material;
                cells[i + 1, 2] = rows[i].Pieces;
                cells[i + 1, 3] = (double)Math.Round(rows[i].Length, 3);
                cells[i + 1, 4] = (double)Math.Round(rows[i].Length / (metric ? 1000m : 12m), 3);
                cells[i + 1, 5] = rows[i].Unmeasured == 0 ? (object)"" : rows[i].Unmeasured;
            }
            var widths = new[] { 40, 26, 10, 18, 18, 20 };
            for (int i = 0; i < widths.Length; i++) sheet.Columns[i + 1].ColumnWidth = widths[i];
            sheet.Range["A:B"].NumberFormat = "@";
            dynamic used = sheet.Range["A1", "F" + (rows.Count + 1)];
            used.Value2 = cells;
            dynamic heading = sheet.Range["A1:F1"];
            heading.Font.Bold = true;
            heading.Font.Color = 16777215;
            heading.Interior.Color = 6693657;
            heading.RowHeight = 23;
            used.AutoFilter(1);
            first.Activate();
        }

        private static string ExportLengthSource(Label label, string length)
        {
            string expression, evaluated;
            bool resolved, linked;
            label.Manager.Get6("Length", false, out expression, out evaluated, out resolved, out linked);
            if (IsNativeLengthExpression(expression)) return "SolidWorks cut length";
            decimal value, rounded;
            if (label.Dimensions != null && TryPositiveLength(length, out value) &&
                UnitOptions(label, 2).Values.Any(options => Array.Exists(options, option =>
                    Decimal.TryParse(option, NumberStyles.Number, CultureInfo.InvariantCulture, out rounded) && rounded == value)))
                return label.LengthSource + " (matches)";
            return String.IsNullOrWhiteSpace(length) ? "" : "Stored value";
        }
    }
}
