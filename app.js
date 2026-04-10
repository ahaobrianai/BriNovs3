// ===============================
// 1. SPA NAVIGATION ENGINE
// ===============================
const navLinks = document.querySelectorAll('.nav-link');
const sections = document.querySelectorAll('.spa-section');

function switchSection(sectionId) {
    // 1. Remove active class from all nav links
    navLinks.forEach(link => link.classList.remove('active-tab'));
    
    // 2. Hide all sections
    sections.forEach(section => {
        section.classList.remove('active-section');
        section.style.display = 'none';
    });

    // 3. Show target section
    const targetSection = document.getElementById(sectionId);
    if (targetSection) {
        targetSection.classList.add('active-section');
        targetSection.style.display = 'block';
        
        // 4. Update the Nav Tab styling
        const activeLink = document.querySelector(`[data-section="${sectionId}"]`);
        if (activeLink) activeLink.classList.add('active-tab');
        
        console.log(`System: Switched to ${sectionId} view. Bot remains active.`);
    }
}

// Add click listeners to all navigation elements
navLinks.forEach(link => {
    link.addEventListener('click', () => {
        const sectionId = link.getAttribute('data-section');
        switchSection(sectionId);
    });
});

// ===============================
// 2. CLOCK & UI INITIALIZATION
// ===============================
function updateClock() {
    const now = new Date();
    const tz = document.getElementById("timezone-toggle").value;
    
    const timeStr = now.toLocaleTimeString('en-GB', { 
        timeZone: tz === 'EAT' ? 'Africa/Nairobi' : 'UTC', 
        hour12: false 
    });
    const dateStr = now.toLocaleDateString('en-GB', { 
        timeZone: tz === 'EAT' ? 'Africa/Nairobi' : 'UTC',
        day: '2-digit', month: '2-digit', year: 'numeric' 
    });

    document.getElementById("clock").textContent = timeStr;
    document.getElementById("date").textContent = dateStr;
}

// ===============================
// 3. SPLASH SCREEN ENGINE
// ===============================
const loadingPhrases = ["Where PATIENCE pays...", "Almost there...", "Done 🎉"];
let phraseIndex = 0, charIndex = 0, isDeleting = false;

function typeEffect() {
    const textEl = document.getElementById("loading-text");
    if (!textEl) return;
    const currentPhrase = loadingPhrases[phraseIndex];

    textEl.textContent = isDeleting
        ? currentPhrase.substring(0, charIndex - 1)
        : currentPhrase.substring(0, charIndex + 1);

    charIndex = isDeleting ? charIndex - 1 : charIndex + 1;
    let typeSpeed = isDeleting ? 40 : 80;

    if (!isDeleting && charIndex === currentPhrase.length) {
        typeSpeed = 1200;
        isDeleting = true;
    } else if (isDeleting && charIndex === 0) {
        isDeleting = false;
        phraseIndex = (phraseIndex + 1) % loadingPhrases.length;
        typeSpeed = 300;
    }
    setTimeout(typeEffect, typeSpeed);
}

function hideSplashScreen() {
    const splash = document.getElementById("splash-screen");
    if (splash) {
        splash.style.opacity = "0";
        setTimeout(() => splash.style.display = "none", 800);
    }
}

// ===============================
// 4. STARTUP
// ===============================
window.onload = () => {
    typeEffect();
    setInterval(updateClock, 1000);
    
    // Auto-hide splash after 3 seconds for demo
    setTimeout(hideSplashScreen, 3500);
    
    console.log("BriNovs FX Engine: Session Started (SPA Mode)");
};
