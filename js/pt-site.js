(function(){
  var nav=document.getElementById('nav');
  if(nav){var onS=function(){nav.classList.toggle('stuck',window.scrollY>40)};onS();window.addEventListener('scroll',onS,{passive:true});}
  var b=document.getElementById('burger'),l=document.getElementById('navLinks');
  if(b&&l){b.addEventListener('click',function(){var o=l.classList.toggle('open');b.setAttribute('aria-expanded',o?'true':'false')});
  l.addEventListener('click',function(e){if(e.target.tagName==='A'){l.classList.remove('open');b.setAttribute('aria-expanded','false')}});}
  var rv=document.querySelectorAll('.rv');
  if('IntersectionObserver' in window){var io=new IntersectionObserver(function(en){en.forEach(function(x){if(x.isIntersecting){x.target.classList.add('in');io.unobserve(x.target)}})},{rootMargin:'0px 0px -8% 0px',threshold:.08});rv.forEach(function(e){io.observe(e)})}else{rv.forEach(function(e){e.classList.add('in')})}
  var y=document.getElementById('yr'); if(y) y.textContent=new Date().getFullYear();
})();
(function(){document.querySelectorAll('.dd-btn').forEach(function(b){b.addEventListener('click',function(e){var d=b.parentElement;var o=d.classList.toggle('open');b.setAttribute('aria-expanded',o?'true':'false');e.stopPropagation()})});document.addEventListener('click',function(){document.querySelectorAll('.dd.open').forEach(function(d){d.classList.remove('open')})})})();

/* SMS consent gate (A2P 10DLC): block a marked submit until the page's consent
   box is checked. Carriers require an active opt-in before a number is texted. */
(function(){
  function msg(wrap, show){ if(!wrap) return; wrap.classList.toggle('sms-consent-err', show); var m=wrap.querySelector('.sms-consent-msg'); if(m) m.hidden=!show; }
  // JS-fetch buttons: capture phase, so this runs BEFORE the page's own click handler.
  document.addEventListener('click', function(e){
    var btn = e.target.closest('[data-consent-gate]'); if(!btn) return;
    var box = document.querySelector('.js-sms-consent'); if(!box || box.checked) return;
    e.preventDefault(); e.stopImmediatePropagation();
    msg(box.closest('.sms-consent-wrap'), true); try{ box.focus(); }catch(_){}
  }, true);
  // Native <form> submits (incl. Enter key): backup to the checkbox's own `required`.
  document.addEventListener('submit', function(e){
    var box = e.target.querySelector('.js-sms-consent'); if(!box || box.checked) return;
    e.preventDefault(); e.stopImmediatePropagation();
    msg(box.closest('.sms-consent-wrap'), true); try{ box.focus(); }catch(_){}
  }, true);
  // Clear the error once they check it.
  document.addEventListener('change', function(e){
    if(e.target && e.target.classList && e.target.classList.contains('js-sms-consent'))
      msg(e.target.closest('.sms-consent-wrap'), !e.target.checked);
  });
})();
