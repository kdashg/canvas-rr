const s = document.createElement('script');
const url = browser.runtime.getURL('rr-record.js');
/*
(async () => {
   const resp = await fetch(url);
   const text = await resp.text();
})();
*/
const request = new XMLHttpRequest();
request.open('GET', url, false);  // `false` makes the request synchronous
request.send(null);
//console.log(request.status);
s.textContent = request.responseText;
(document.head || document.documentElement).appendChild(s);

//s.onload = function() {
//   this.remove();
//};
