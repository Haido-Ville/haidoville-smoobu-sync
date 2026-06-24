<style>
  @import url('https://fonts.googleapis.com/css2?family=Manrope:wght@300;400;500;600;700;800&family=Cormorant+Garamond:ital,wght@0,300;0,400;0,600;1,300&family=DM+Sans:wght@300;400;500&display=swap');

  :root {
    --gold: #C9A96E;
    --dark: #1a1a1a;
    --light: #f5f3ef;
    --white: #ffffff;
    --mid: #6b6b6b;
  }

  * { margin: 0; padding: 0; box-sizing: border-box; }

  .antra-testi {
    position: relative;
    width: 100vw;
    max-width: 100vw;
    left: 50%;
    margin-left: -50vw;
    background: var(--dark);
    padding: 110px 0;
    font-family: 'DM Sans', sans-serif;
    overflow: hidden;
  }

  .antra-testi__inner {
    max-width: 1320px;
    margin: 0 auto;
    padding: 0 40px;
  }

  .antra-testi__header {
    display: flex;
    align-items: flex-end;
    justify-content: space-between;
    gap: 40px;
    margin-bottom: 60px;
    flex-wrap: wrap;
  }

  .antra-testi__tag {
    display: flex;
    align-items: center;
    gap: 12px;
    margin-bottom: 18px;
  }

  .antra-testi__tag-line { width: 36px; height: 1px; background: var(--gold); }
  .antra-testi__tag-text {
    font-size: 11px;
    font-weight: 400;
    letter-spacing: 4px;
    text-transform: uppercase;
    color: var(--gold);
  }

  .antra-testi .antra-testi__heading,
  .antra-testi h2.antra-testi__heading,
  h2.antra-testi__heading {
    font-family: 'Manrope', sans-serif !important;
    font-size: clamp(26px, 3vw, 42px) !important;
    font-weight: 800 !important;
    line-height: 1.15 !important;
    color: var(--white) !important;
    letter-spacing: -1px !important;
    font-style: normal !important;
    text-transform: none !important;
  }

  .antra-testi .antra-testi__heading em,
  h2.antra-testi__heading em {
    font-family: 'Manrope', sans-serif !important;
    font-style: normal !important;
    color: var(--gold) !important;
    font-weight: 800 !important;
  }

  .antra-testi__rating-summary {
    display: flex;
    flex-direction: column;
    align-items: flex-end;
    gap: 8px;
  }

  .antra-testi__rating-num {
    font-family: 'Cormorant Garamond', serif;
    font-size: 52px;
    font-weight: 600;
    color: var(--white);
    line-height: 1;
  }

  .antra-testi__stars { display: flex; gap: 4px; }
  .antra-testi__stars svg { width: 16px; height: 16px; fill: var(--gold); }

  .antra-testi__rating-label {
    font-size: 12px;
    font-weight: 300;
    color: rgba(255,255,255,0.4);
    letter-spacing: 1px;
  }

  .antra-testi__track-wrap { overflow: hidden; }

  .antra-testi__track {
    display: flex;
    gap: 24px;
    transition: transform 0.5s cubic-bezier(0.25, 0.46, 0.45, 0.94);
  }

  .antra-testi__card {
    flex: 0 0 calc(33.333% - 16px);
    background: rgba(255,255,255,0.04);
    border: 1px solid rgba(255,255,255,0.07);
    padding: 40px;
    position: relative;
    display: flex;
    flex-direction: column;
  }

  .antra-testi__quote-mark {
    font-family: 'Cormorant Garamond', serif;
    font-size: 80px;
    color: var(--gold);
    line-height: 0.5;
    margin-bottom: 24px;
    opacity: 0.4;
  }

  .antra-testi__card-stars { display: flex; gap: 3px; margin-bottom: 18px; }
  .antra-testi__card-stars svg { width: 14px; height: 14px; }
  .antra-testi__card-stars svg.star-filled { fill: var(--gold); }
  .antra-testi__card-stars svg.star-empty { fill: rgba(201,169,110,0.2); }

  .antra-testi__card-text {
    font-size: 15px;
    font-weight: 300;
    color: rgba(255,255,255,0.65);
    line-height: 1.85;
    margin-bottom: 32px;
    font-style: italic;
    flex-grow: 1;
  }

  .antra-testi__card-author { display: flex; align-items: center; gap: 14px; margin-top: auto; }

  .antra-testi__card-avatar {
    width: 46px;
    height: 46px;
    border-radius: 50%;
    object-fit: cover;
    border: 2px solid rgba(201,169,110,0.3);
    flex-shrink: 0;
  }

  .antra-testi__card-name {
    font-size: 14px;
    font-weight: 500;
    color: var(--white);
    margin-bottom: 3px;
  }

  .antra-testi__card-role {
    font-size: 12px;
    font-weight: 300;
    color: var(--gold);
    letter-spacing: 1px;
  }

  .antra-testi__controls {
    display: flex;
    align-items: center;
    gap: 12px;
    margin-top: 40px;
  }

  .antra-testi__btn {
    width: 48px;
    height: 48px;
    border: 1px solid rgba(255,255,255,0.2);
    background: transparent;
    cursor: pointer;
    display: flex;
    align-items: center;
    justify-content: center;
    transition: all 0.3s;
    color: var(--white);
  }

  .antra-testi__btn:hover { background: var(--gold); border-color: var(--gold); color: var(--dark); }
  .antra-testi__btn svg { width: 18px; height: 18px; }

  .antra-testi__progress {
    flex: 1;
    height: 1px;
    background: rgba(255,255,255,0.1);
    position: relative;
  }

  .antra-testi__progress-bar {
    position: absolute;
    top: 0; left: 0;
    height: 100%;
    background: var(--gold);
    transition: width 0.5s ease;
  }

  .antra-testi__logos {
    margin-top: 72px;
    border-top: 1px solid rgba(255,255,255,0.07);
    padding-top: 48px;
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 32px;
    flex-wrap: wrap;
  }

  .antra-testi__logo-label {
    font-size: 11px;
    font-weight: 400;
    letter-spacing: 3px;
    text-transform: uppercase;
    color: rgba(255,255,255,0.25);
    white-space: nowrap;
  }

  .antra-testi__logo-items { display: flex; align-items: center; gap: 40px; flex-wrap: wrap; }

  .antra-testi__logo-item {
    font-family: 'Cormorant Garamond', serif;
    font-size: 18px;
    font-weight: 400;
    color: rgba(255,255,255,0.2);
    letter-spacing: 2px;
    text-transform: uppercase;
    transition: color 0.3s;
    cursor: default;
    white-space: nowrap;
  }

  .antra-testi__logo-item:hover { color: rgba(255,255,255,0.5); }

  @media (max-width: 960px) {
    .antra-testi__card { flex: 0 0 calc(50% - 12px); }
    .antra-testi__rating-summary { align-items: flex-start; }
  }

  @media (max-width: 640px) {
    .antra-testi { padding: 80px 0; }
    .antra-testi__inner { padding: 0 20px; }
    .antra-testi__card { flex: 0 0 calc(100%); }
    .antra-testi__logos { flex-direction: column; align-items: flex-start; gap: 20px; }
    .antra-testi__logo-items { gap: 24px; }
  }
</style>

<section class="antra-testi" id="testimonials">
  <div class="antra-testi__inner">

    <div class="antra-testi__header">
      <div>
        <div class="antra-testi__tag">
          <span class="antra-testi__tag-line"></span>
          <span class="antra-testi__tag-text">Guest Feedback</span>
        </div>
        <h2 class="antra-testi__heading">
          Here's What Guests<br><em>Say About Us</em>
        </h2>
      </div>
      <div class="antra-testi__rating-summary">
        <div class="antra-testi__rating-num">4.9</div>
        <div class="antra-testi__stars">
          <svg viewBox="0 0 24 24"><polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"/></svg>
          <svg viewBox="0 0 24 24"><polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"/></svg>
          <svg viewBox="0 0 24 24"><polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"/></svg>
          <svg viewBox="0 0 24 24"><polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"/></svg>
          <svg viewBox="0 0 24 24"><polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"/></svg>
        </div>
        <div class="antra-testi__rating-label">Based on Excellent Reviews</div>
      </div>
    </div>

    <div class="antra-testi__track-wrap">
      <div class="antra-testi__track" id="antraTestiTrack"></div>
    </div>

    <div class="antra-testi__controls">
      <button class="antra-testi__btn" id="antraTestiPrev" aria-label="Previous">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="19" y1="12" x2="5" y2="12"/><polyline points="12 5 5 12 12 19"/></svg>
      </button>
      <button class="antra-testi__btn" id="antraTestiNext" aria-label="Next">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="5" y1="12" x2="19" y2="12"/><polyline points="12 5 19 12 12 19"/></svg>
      </button>
      <div class="antra-testi__progress">
        <div class="antra-testi__progress-bar" id="antraTestiBar"></div>
      </div>
    </div>

    <div class="antra-testi__logos">
      <div class="antra-testi__logo-label">Find Us On</div>
      <div class="antra-testi__logo-items">
        <div class="antra-testi__logo-item">Facebook</div>
        <div class="antra-testi__logo-item">Airbnb</div>
        <div class="antra-testi__logo-item">Agoda</div>
        <div class="antra-testi__logo-item">Booking.com</div>
        <div class="antra-testi__logo-item">Google Reviews</div>
      </div>
    </div>

  </div>
</section>

<script>
(function () {

  // Mga Helpers para sa Stars
  var STAR_FILLED = '<svg class="star-filled" viewBox="0 0 24 24"><polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"/></svg>';
  var STAR_EMPTY  = '<svg class="star-empty"  viewBox="0 0 24 24"><polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"/></svg>';

  function buildStars(n) {
    var html = '';
    for (var i = 1; i <= 5; i++) { html += (i <= n) ? STAR_FILLED : STAR_EMPTY; }
    return html;
  }

  // Data ng Reviews
  var TESTIMONIALS = [
    {
      name: 'CC Tuminez', role: 'Guest, HaiDo Ville',
      avatar: 'https://assets.cdn.filesafe.space/s7j5HqPutVcKrXgWP2oR/media/69c358c71588f26ff92cad02.png',
      stars: 5, text: '"Highly recommended, most especially for those travellers who are looking for an affordable, clean and very welcoming environment. I am really satisfied po! thank you so much for the warm welcome po and hopefully makabalik po ako ulit soon ❤️"'
    },
    {
      name: 'Angec Salvador', role: 'Guest, HaiDo Ville',
      avatar: 'https://assets.cdn.filesafe.space/s7j5HqPutVcKrXgWP2oR/media/69c358c7ac7da2860ca4006a.png',
      stars: 5, text: '"Tysm HaiDo Ville 🫶🏼 I had a very relaxing stay w you, until next time 🌴 If u plan on going to siargao please book your stay here, super nice place ☺️"'
    },
    {
      name: 'Geovanni Collantes Dumpasan', role: 'Guest, HaiDo Ville',
      avatar: 'https://assets.cdn.filesafe.space/s7j5HqPutVcKrXgWP2oR/media/69c358c703ff7b7b7f1cf18b.png',
      stars: 5, text: '"Salamat po sa lahat ng help sa pagfacilitate ng aming tours especially our stay at your accommodation. We enjoyed our stay here at Siargao. Sobrang accessible po talaga yung place maam. Thank you po ulit."'
    },
    {
      name: 'Jjervi May Calunsag', role: 'Guest, HaiDo Ville',
      avatar: 'https://assets.cdn.filesafe.space/s7j5HqPutVcKrXgWP2oR/media/69c358c7ab2203ed8082be0e.png',
      stars: 4, text: '"Good morning...im so happy with the room I had po, napaka accomodating. Very approachable and nag sasmile pa. Highly recommended with the perfect spot in the heart of tourism."'
    },
    {
      name: 'Jovany Dandanon Pagios', role: 'Guest, HaiDo Ville',
      avatar: 'https://assets.cdn.filesafe.space/s7j5HqPutVcKrXgWP2oR/media/69c358c71588f2823d2cad09.png',
      stars: 5, text: '"Thank you Din Po highly recommended napaka mura lang at napaka malinis ❤️💯"'
    },
    {
      name: 'Gilbert Solares Vibal', role: 'Solo Traveler',
      avatar: 'https://assets.cdn.filesafe.space/s7j5HqPutVcKrXgWP2oR/media/69c358c725c6994cac2cc5a8.png',
      stars: 5, text: '"Recommended place for solo traveller, trustworthy and superb service. Very memorable ang first Siargao trip ko dahil sa WanderWave Travel and Tours and HaiDo Ville. Until next time 💯"'
    },
    {
      name: 'Jubiemay Liwagon Parada', role: 'Guest, HaiDo Ville',
      avatar: 'https://assets.cdn.filesafe.space/s7j5HqPutVcKrXgWP2oR/media/69c358c71588f220cb2cad0a.png',
      stars: 5, text: '"thankyouuu so much for your warm accommodation, ma\'am! I\'ve met a new friend in youuu. your warmth is what makes your homestay unique!♡"'
    },
    {
      name: 'Nat Catap', role: 'Guest, HaiDo Ville',
      avatar: 'https://assets.cdn.filesafe.space/s7j5HqPutVcKrXgWP2oR/media/69c358c725c6993d632cc5ac.png',
      stars: 4, text: '"Talagang SOBRANG salamat po sa inyo. Happy kami talaga na jan kami nakahanap nang matutuloyan, dahil po sobrang accommodating niyo po at sobrang smooth. Pagmaka siargao kami ulit ng friends ko jan talaga kami ulit. Solid talaga ang Haido para sa amin. More blessings and power sa inyo!"'
    },
    {
      name: 'Bhemelou M. Alcesto', role: 'Guest, HaiDo Ville',
      avatar: 'https://assets.cdn.filesafe.space/s7j5HqPutVcKrXgWP2oR/media/69c358c703ff7b500c1cf189.png',
      stars: 5, text: '"Sobrang worth it ang ilang days na pag stay ko sa Haido, definitely reccommend Haido to my friends and fam na gusto mag bakasyon ng Siargao soon. Para lang akong malayong kamag-anak na nagbakasyon diyan kasi at home na at home ang feeling ko. Clean place and peacefull at sobrang convenient ng mga bars at kainan kasi walking distance lang."'
    },
    {
      name: 'Marie Ayen', role: 'Guest, HaiDo Ville',
      avatar: 'https://assets.cdn.filesafe.space/s7j5HqPutVcKrXgWP2oR/media/69c358c703ff7b11b21cf18a.png',
      stars: 5, text: '"Thank you maam sa very chill accommodation super satisfied mi and we\'ll come back soon. I\'ll recommend it to my other friends very accessible lng sa mga stores and night life party. At home na at home yung feeling namin, para din kaming lokal sa siargao."'
    },
    {
      name: 'Lowell Sarcina Manseneros', role: 'Solo Traveler',
      avatar: 'https://assets.cdn.filesafe.space/s7j5HqPutVcKrXgWP2oR/media/69c358c7ac7da25571a40069.png',
      stars: 4, text: '"Thank you so much for accommodating my stay in Siargao. Although, Im traveling alone but I never felt lonely, indeed a great experience. I would like to commend the staff for a job well done."'
    },
    {
      name: 'Sarae Tenedero', role: 'Guest, HaiDo Ville',
      avatar: 'https://assets.cdn.filesafe.space/s7j5HqPutVcKrXgWP2oR/media/69c358c7ab22037e4e82be0d.png',
      stars: 5, text: '"Thank you, HaiDo Ville 🫶🏼 I had a great stay! Will prolly stay here again when I come back next year. Maraming salamat 🥰"'
    },
    {
      name: 'Julianne Suarez', role: 'Guest, HaiDo Ville',
      avatar: 'https://assets.cdn.filesafe.space/s7j5HqPutVcKrXgWP2oR/media/69c358c71588f255292cacfd.png',
      stars: 5, text: '"Hello po! Thank you po ulit for welcoming us. Babalik po kami for sure. Will also recommend you to our friends. ❤️"'
    },
    {
      name: 'Christinee Gaay P. Liberato', role: 'Solo Traveler',
      avatar: 'https://assets.cdn.filesafe.space/s7j5HqPutVcKrXgWP2oR/media/69c358c7ac7da29637a40063.png',
      stars: 4, text: '"As a solo traveller, may mga worries ako nung una since babae ako at unfamiliar ang Siargao sakin. Thankfully, very considerate ng Haido Ville staff sa situation ko. After a day, magkakaibigan na kami sa homestay. We partied, we ate out and we became friends."'
    },
    {
      name: 'Michael Harismendy', role: 'Guest, HaiDo Ville',
      avatar: 'https://assets.cdn.filesafe.space/s7j5HqPutVcKrXgWP2oR/media/69c358c703ff7b486a1cf182.png',
      stars: 5, text: '"Everything went very well, I particularly appreciated the location, ideally located in the center of General Luna, while remaining calm. I will go back if necessary! THANKS"'
    },
    {
      name: 'Weena Joyce', role: 'Guest, HaiDo Ville',
      avatar: 'https://assets.cdn.filesafe.space/s7j5HqPutVcKrXgWP2oR/media/69c358c703ff7bbb521cf18d.png',
      stars: 4, text: '"Thank you, HaiDo Ville. We had a great time spending our vacation in Siargao with you as our accommodation. Very kind and approachable staff. Sulit na sulit. Sa sunod na pod"'
    },
    {
      name: 'Dianne Gutierrez', role: 'Guest, HaiDo Ville',
      avatar: 'https://assets.cdn.filesafe.space/s7j5HqPutVcKrXgWP2oR/media/69c358c7ab2203c59f82be0c.png',
      stars: 5, text: '"Hello po! thank you so much din po, sobra bait po nila ate and we\'re happy kasi naka bond namin sila. Hehehe If mag balik kami soon sa inyo parin kami mag book. Hehe"'
    },
    {
      name: 'Chaw Whikz', role: 'Guest, HaiDo Ville',
      avatar: 'https://assets.cdn.filesafe.space/s7j5HqPutVcKrXgWP2oR/media/69c358c703ff7b075c1cf18c.png',
      stars: 5, text: '"Anyway, thank you so much ma\'am for the warm welcome po sa Haido Ville and will surely po na babalik po sa inyo para mag stay. So clean po ng CR and convenient po ang area sa lahat na pupuntahan. 11/10 po ❤️👌"'
    }
  ];

  function shuffle(arr) {
    var a = arr.slice();
    for (var i = a.length - 1; i > 0; i--) {
      var j = Math.floor(Math.random() * (i + 1));
      var t = a[i]; a[i] = a[j]; a[j] = t;
    }
    return a;
  }

  function buildCard(t) {
    return '<div class="antra-testi__card">' +
      '<div class="antra-testi__quote-mark">\u201c</div>' +
      '<div class="antra-testi__card-stars">' + buildStars(t.stars) + '</div>' +
      '<p class="antra-testi__card-text">' + t.text + '</p>' +
      '<div class="antra-testi__card-author">' +
        '<img src="' + t.avatar + '" alt="' + t.name + '" class="antra-testi__card-avatar">' +
        '<div>' +
          '<div class="antra-testi__card-name">' + t.name + '</div>' +
          '<div class="antra-testi__card-role">' + t.role + '</div>' +
        '</div>' +
      '</div>' +
    '</div>';
  }

  // --- INIT CAROUSEL LOGIC ---
 function initializeTestimonials() {
    var track = document.getElementById('antraTestiTrack');
    if (!track || track.dataset.loaded) return;

    var trackWrap = track.parentElement;
    if (!trackWrap || trackWrap.offsetWidth === 0) {
        setTimeout(initializeTestimonials, 200);
        return;
    }

    var shuffled = shuffle(TESTIMONIALS);
    track.innerHTML = shuffled.map(buildCard).join('');
    track.dataset.loaded = 'true';

    var prevBtn = document.getElementById('antraTestiPrev');
    var nextBtn = document.getElementById('antraTestiNext');
    var bar     = document.getElementById('antraTestiBar');
    var cards   = track.querySelectorAll('.antra-testi__card');
    var current = 0;

    function getVisible() {
        if (window.innerWidth <= 640) return 1;
        if (window.innerWidth <= 960) return 2;
        return 3;
    }

    // FIX: Dynamically set card widths based on actual wrapper width
    function setCardWidths() {
        var ww  = trackWrap.offsetWidth || (window.innerWidth - 80);
        var vis = getVisible();
        var cw  = Math.floor((ww - (vis - 1) * 24) / vis);
        cards.forEach(function(c) {
            c.style.flex     = 'none';
            c.style.width    = cw + 'px';
            c.style.minWidth = cw + 'px';
        });
    }

    function getCardWidth() {
        return cards.length ? (cards[0].offsetWidth + 24) : 0;
    }

    function maxIndex() {
        return Math.max(0, cards.length - getVisible());
    }

    function update() {
        setCardWidths();
        var w = getCardWidth();
        if (w > 0) {
            track.style.transform = 'translateX(-' + (current * w) + 'px)';
            if (bar) bar.style.width = (maxIndex() === 0 ? 100 : (current / maxIndex()) * 100) + '%';
        }
    }

    if (prevBtn) prevBtn.addEventListener('click', function() { current = Math.max(0, current - 1); update(); });
    if (nextBtn) nextBtn.addEventListener('click', function() { current = Math.min(maxIndex(), current + 1); update(); });
    window.addEventListener('resize', function() { current = Math.min(current, maxIndex()); update(); });

    setTimeout(update, 50); // Slight delay para masigurado naka-layout na
}

  // --- POLLING LOGIC PARA SA GHL ---
  // Hihintayin nito na maging > 0 ang lapad ng wrapper bago i-load, para iwas layout bug.
  var _hvTc = setInterval(function() {
    var el = document.getElementById('antraTestiTrack');
    if (el && el.parentElement && el.parentElement.offsetWidth > 0) {
        clearInterval(_hvTc);
        initializeTestimonials();
    }
  }, 150);
  // Hard fallback after 5 seconds
  setTimeout(function() { clearInterval(_hvTc); initializeTestimonials(); }, 5000);

})();
</script>
