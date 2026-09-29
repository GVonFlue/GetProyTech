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
