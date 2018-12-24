﻿using CodeStream.VisualStudio.Services;
using Microsoft.VisualStudio.Shell;
using Microsoft.VisualStudio.Text.Editor;
using System.Windows;
using System.Windows.Controls;

namespace CodeStream.VisualStudio.UI.Margins
{
    public partial class Codemark : UserControl
    {
        private CodemarkViewModel _viewModel;

        public Codemark(CodemarkViewModel viewModel)
        {
            //Default height used for repositioning in the margin
            Height = 19;
            _viewModel = viewModel;
            InitializeComponent();
            DataContext = this;
            ImageUri = $"pack://application:,,,/CodeStream.VisualStudio;component/Resources/Assets/marker-{_viewModel.Marker.Codemark.Type}-{_viewModel.Marker.Codemark.Color}.png";
        }

        public static readonly DependencyProperty ImageUriProperty =
            DependencyProperty.Register("ImageUri", typeof(string), typeof(Codemark));

        public string ImageUri
        {
            get { return (string)GetValue(ImageUriProperty); }
            set { SetValue(ImageUriProperty, value); }
        }

        private void Codemark_MouseDown(object sender, System.Windows.Input.MouseButtonEventArgs e)
        {
            //var codeStreamService = Package.GetGlobalService(typeof(SCodeStreamService)) as ICodeStreamService;
           // codeStreamService.OpenCommentAsync(null, _viewModel.Marker.)
            MessageBox.Show(_viewModel.Marker.Code);
        }

        private static int buffer = 5;

        public void Reposition(IWpfTextView textView, int offset)
        {
            Canvas.SetLeft(this, 0);
            Canvas.SetTop(this, offset - textView.ViewportTop + Height - buffer);
        }
    }
}