module.exports = `
*{box-sizing:border-box}
html{background:#fff;color:#171717;font-family:Arial,Helvetica,sans-serif;font-size:30px}
body{margin:0;line-height:1.45}
header,nav,main,article,section{display:block}
a{color:inherit}
a:focus,input:focus,button:focus{outline:2px solid #111;outline-offset:3px}
.wrap{width:100%;max-width:none;margin:0 auto;padding:0 20px}
.masthead{display:table;width:100%;padding:24px 0 19px}
.brand,.account{display:table-cell;vertical-align:middle}
.brand{font-size:28px;font-weight:700;letter-spacing:-.5px}
.brand a{text-decoration:none}
.account{text-align:right;font-size:24px}
.account a{text-underline-offset:4px}
.nav{border-bottom:1px solid #999;padding:0 0 14px}
.nav a{display:inline-block;text-decoration:none;margin-right:24px;font-size:26px;padding:6px 0}
.nav .active{font-weight:700;border-bottom:2px solid #171717}
.nav a:last-child{margin-right:0}
main{padding:32px 0 26px}
h1{font-family:Georgia,'Times New Roman',serif;font-size:44px;letter-spacing:-1px;line-height:1.2;margin:0 0 12px;font-weight:400}
.intro{color:#444;margin:0 0 24px;font-size:24px}
.search{background:#f7f7f7;border:1px solid #aaa;border-radius:5px;padding:23px 24px 19px}
.fields{display:table;width:100%;table-layout:fixed}
.field{display:table-cell;width:50%;vertical-align:top}
.field:first-child{padding-right:10px}
.field:last-child{padding-left:10px}
label{display:block;font-size:28px;font-weight:700;margin:0 0 8px}
input{display:block;width:100%;min-width:0;border:1px solid #666;border-radius:3px;background:#fff;color:#111;font:inherit;padding:12px;line-height:1.3}
.actions{margin-top:20px;overflow:hidden}
.primary{display:inline-block;vertical-align:middle;padding:12px 26px;min-height:48px;border:1px solid #171717;border-radius:3px;background:#171717;color:#fff;font:inherit;font-weight:700;cursor:pointer}
.reset{display:inline-block;vertical-align:middle;font-size:22px;margin-left:18px;text-underline-offset:3px}
.options{float:right;display:block;margin:14px 0 0;font-size:22px;text-underline-offset:3px}
.scope{font-size:22px;color:#444;margin:16px 0 0}
.scope span{padding:0 8px}
.result-header{display:table;width:100%;margin-top:31px;padding-bottom:13px;border-bottom:2px solid #171717}
.result-header h2{display:table-cell;font-size:26px;line-height:1.4;margin:0;font-weight:700}
.result-header p{display:table-cell;text-align:right;font-size:22px;margin:0;color:#444}
.result{position:relative;padding:22px 0 21px;border-bottom:1px solid #bbb;word-wrap:break-word}
.result h3{font-family:Georgia,'Times New Roman',serif;font-size:34px;line-height:1.35;letter-spacing:-.25px;margin:0 0 8px;font-weight:400}
.result h3 a{text-decoration:none;border-bottom:1px solid #777}
.author{font-size:28px;margin:0 0 5px}
.series{font-size:24px;color:#444;margin:0 0 5px}
.book-meta{font-size:24px;color:#444;margin:10px 0 0}
.book-meta span{padding:0 6px}
.book-format{display:block;position:static;font-size:22px;color:#444;margin:0 0 7px}
.pages{display:table;width:100%;margin:23px 0 0;padding-top:0}
.pages .page-number{display:table-cell;vertical-align:middle;font-size:22px;color:#333}
.page-links{display:table-cell;text-align:right}
.page-links a{display:inline-block;padding:10px 16px;border:1px solid #333;border-radius:3px;font-size:22px;text-decoration:none}
.page-links .disabled{display:inline-block;padding:10px 16px;margin-right:8px;color:#777;font-size:22px}
 @media(max-width:520px){.wrap{padding:0 18px}
.masthead{display:block;padding:20px 0 15px}
.brand,.account{display:block}
.account{text-align:left;margin-top:10px}
.nav a{margin-right:18px}
main{padding-top:27px}
h1{font-size:40px}
.intro{margin-bottom:20px}
.search{padding:20px 18px}
.fields,.field{display:block;width:100%}
.field:first-child,.field:last-child{padding:0}
.field+.field{margin-top:18px}
.primary{width:100%}
.reset{margin:16px 0 0}
.options{margin-top:16px}
.scope{margin-top:17px}
.scope span{padding:0 5px}
.result-header{margin-top:27px}
.result{padding:21px 0 20px}
.result h3{font-size:32px}
.page-links a{padding:10px 13px}
.page-links .disabled{padding:10px 8px;margin-right:0}
}

  body{word-wrap:break-word}
h2{font-size:28px}
button,.button{display:inline-block;border:1px solid #333;border-radius:3px;background:#fff;color:#171717;padding:11px 17px;font:inherit;line-height:1.4;text-decoration:none;margin:5px 8px 5px 0;cursor:pointer}
select{box-sizing:border-box;max-width:100%;background:#fff;color:#111;border:1px solid #666;border-radius:3px;font:inherit;padding:11px;width:100%}
.primary{background:#171717;color:#fff}
.options{border:0;background:none;padding:0;margin-right:0;text-decoration:underline}
.meta,.hint{font-size:24px;color:#444}
.inline{display:inline}
.inline button{border:0;background:none;padding:0;margin:0 0 0 12px;text-decoration:underline;font-size:22px}
.auth{max-width:28em}
.auth input{margin-bottom:18px}
.account span{display:inline-block;max-width:11em;vertical-align:middle;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.pagination{clear:both;border:0;padding:18px 0;font-size:24px}
.pagination a{display:inline-block;padding:10px 13px;border:1px solid #333;border-radius:3px;text-decoration:none;margin:4px 8px 4px 0}
.cover{float:left;width:64px;height:94px;object-fit:contain;margin:0 14px 8px 0}
.result{clear:both;overflow:hidden}
.result p{margin:5px 0}
.annotation,.reading{white-space:pre-wrap;word-wrap:break-word;overflow-wrap:anywhere}
.reading{max-width:42em;font-family:Georgia,serif;line-height:1.65}
.error{border:1px solid #333;padding:16px}
fieldset{border:1px solid #aaa;margin:20px 0;padding:18px}
fieldset label{margin-top:14px}
.download-form{max-width:30em;margin:22px 0}
.download-form select{margin-bottom:12px}
.quick-download{margin-top:14px}
.quick-download .button{margin:0}
.shelf-options{border:1px solid #aaa;border-radius:4px;padding:18px;margin:20px 0}
.shelf-options label{margin-bottom:8px}
@media(max-width:520px){.nav a{margin-right:15px}
.account span{max-width:8em}
.result{padding-right:0}
.quick-download .button{padding:10px 13px}
}

`;
