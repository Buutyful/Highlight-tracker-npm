
class HighlightTracker {
    constructor(options = {}) {
      if (options.minTimeThreshold && options.minTimeThreshold < 0) {
        throw new Error('minTimeThreshold must be non-negative');
      }
      if (options.samplingRate && options.samplingRate < 0) {
        throw new Error('samplingRate must be non-negative');
      }
      this.options = {
        minTimeThreshold: options.minTimeThreshold || 1000, // minimum time in ms to consider as engagement
        samplingRate: options.samplingRate || 200, // how often to check visibility in ms
        heatmapContainer: options.heatmapContainer || null, // container for the heatmap
        heatmapHeight: options.heatmapHeight || 30, // height of heatmap in px
        colors: options.colors || {
          low: '#C6E2FF', // light blue
          medium: '#4F97FF', // medium blue
          high: '#0047AB' // dark blue
        }
      };
  
      this.paragraphs = [];
      this.engagementData = {};
      this.observers = [];
      this.isTracking = false;
      this.scrollbarCreated = false;
  
      // Bind methods
      this.startTracking = this.startTracking.bind(this);
      this.stopTracking = this.stopTracking.bind(this);
      this.checkVisibility = this.checkVisibility.bind(this);
      this.createHeatmap = this.createHeatmap.bind(this);
      this.scrollToElement = this.scrollToElement.bind(this);
      this.handleIntersection = this.handleIntersection.bind(this);
      this.exportData = this.exportData.bind(this);
    }
  
    /**
     * Initializes tracking for all paragraph elements within a container
     * @param {HTMLElement|string} container - The container element or its selector
     */
    init(container) {
      const containerElement = typeof container === 'string' 
        ? document.querySelector(container) 
        : container;
  
      if (!containerElement) {
        console.error('Container element not found');
        return;
      }
  
      // Find all paragraphs
      this.paragraphs = Array.from(containerElement.querySelectorAll('p'));
      
      // Initialize engagement data
      this.paragraphs.forEach((p, index) => {
        // Add data attribute for identification
        p.dataset.highlightId = `p-${index}`;
        
        // Initialize engagement data
        this.engagementData[p.dataset.highlightId] = {
          element: p,
          timeSpent: 0,
          inView: false,
          lastViewTimestamp: null,
          index: index
        };
      });
  
      // Create IntersectionObserver for tracking visibility
      const options = {
        root: null, // viewport
        rootMargin: '0px',
        threshold: [0, 0.25, 0.5, 0.75, 1.0] // multiple thresholds for better accuracy
      };
  
      this.observer = new IntersectionObserver(this.handleIntersection, options);
      
      // Observe all paragraphs
      this.paragraphs.forEach(p => {
        this.observer.observe(p);
      });
      
      return this;
    }
  
    /**
     * Handles intersection events
     * @param {IntersectionObserverEntry[]} entries 
     */
    handleIntersection(entries) {
      if (!this.isTracking) return;
      
      entries.forEach(entry => {
        const id = entry.target.dataset.highlightId;
        const data = this.engagementData[id];
        
        if (!data) return;
        
        // Consider visible if at least 50% visible
        const isNowVisible = entry.intersectionRatio >= 0.5;
        
        if (isNowVisible && !data.inView) {
          // Element just became visible
          data.inView = true;
          data.lastViewTimestamp = Date.now();
        } else if (!isNowVisible && data.inView) {
          // Element just became invisible
          data.inView = false;
          if (data.lastViewTimestamp) {
            data.timeSpent += Date.now() - data.lastViewTimestamp;
            data.lastViewTimestamp = null;
          }
        }
      });
    }
  
    /**
     * Start tracking engagement
     */
    startTracking() {
      if (this.isTracking) return;
      
      this.isTracking = true;
      this.trackingInterval = setInterval(this.checkVisibility, this.options.samplingRate);
      
      return this;
    }
  
    /**
     * Stop tracking engagement
     */
    stopTracking() {
      if (!this.isTracking) return;
      
      this.isTracking = false;
      clearInterval(this.trackingInterval);
      
      // Update final time for elements still in view
      Object.values(this.engagementData).forEach(data => {
        if (data.inView && data.lastViewTimestamp) {
          data.timeSpent += Date.now() - data.lastViewTimestamp;
          data.lastViewTimestamp = null;
          data.inView = false;
        }
      });
      
      return this;
    }
  
    /**
     * Update time spent for elements currently in view
     */
    checkVisibility() {
      const now = Date.now();
      
      Object.values(this.engagementData).forEach(data => {
        if (data.inView && data.lastViewTimestamp) {
          // Update time spent without resetting lastViewTimestamp
          const elapsed = now - data.lastViewTimestamp;
          data.timeSpent += elapsed;
          data.lastViewTimestamp = now;
        }
      });
    }
  
    /**
     * Create a heatmap visualization of engagement data
     * @param {HTMLElement|string} container - Container for the heatmap or its selector
     */
    createHeatmap(container) {
      const containerElement = container || this.options.heatmapContainer;
      const heatmapContainer = typeof containerElement === 'string'
        ? document.querySelector(containerElement)
        : containerElement;
      
      if (!heatmapContainer) {
        console.error('Heatmap container not found');
        return this;
      }
      
      // Clear previous heatmap
      heatmapContainer.innerHTML = '';
      
      // Create heatmap container
      const heatmapWrapper = document.createElement('div');
      heatmapWrapper.className = 'highlight-heatmap-wrapper';
      heatmapWrapper.style.cssText = `
        position: fixed;
        right: 0;
        top: 50%;
        transform: translateY(-50%);
        width: 20px;
        height: 80%;
        background-color: #f0f0f0;
        border-radius: 10px;
        overflow: hidden;
        z-index: 1000;
      `;
      
      // Find max engagement time for normalization
      const engagementValues = Object.values(this.engagementData);
      const maxTime = Math.max(...engagementValues.map(d => d.timeSpent));
      
      // Sort paragraphs by their position in the document
      const sortedParagraphs = engagementValues.sort((a, b) => a.index - b.index);
      
      // Create segments
      sortedParagraphs.forEach(data => {
        const segment = document.createElement('div');
        segment.className = 'highlight-heatmap-segment';
        
        // Calculate height proportion based on the element's size relative to the content
        const documentHeight = document.body.scrollHeight;
        const elementTop = data.element.offsetTop;
        const elementHeight = data.element.offsetHeight;
        const elementBottom = elementTop + elementHeight;
        
        const topPercent = (elementTop / documentHeight) * 100;
        const heightPercent = (elementHeight / documentHeight) * 100;
        
        // Calculate color based on engagement time
        let color;
        const intensity = maxTime ? data.timeSpent / maxTime : 0;
        
        if (intensity < 0.3) {
          color = this.options.colors.low;
        } else if (intensity < 0.7) {
          color = this.options.colors.medium;
        } else {
          color = this.options.colors.high;
        }
        
        segment.style.cssText = `
          position: absolute;
          top: ${topPercent}%;
          height: ${heightPercent}%;
          width: 100%;
          background-color: ${color};
          cursor: pointer;
        `;
        
        // Add click handler to scroll to the paragraph
        segment.addEventListener('click', () => {
          this.scrollToElement(data.element);
        });
        
        // Add tooltip with time information
        segment.title = `Time spent: ${Math.round(data.timeSpent / 1000)}s`;
        
        heatmapWrapper.appendChild(segment);
      });
      
      heatmapContainer.appendChild(heatmapWrapper);
      this.scrollbarCreated = true;
      
      return this;
    }
  
    /**
     * Scroll to a specific paragraph element
     * @param {HTMLElement} element - The paragraph element to scroll to
     */
    scrollToElement(element) {
      element.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }
  
    /**
     * Export engagement data
     * @returns {Object} Engagement data
     */
    exportData() {
      const result = {};
      
      Object.entries(this.engagementData).forEach(([id, data]) => {
        result[id] = {
          index: data.index,
          timeSpent: data.timeSpent,
          timeSpentSeconds: Math.round(data.timeSpent / 1000),
          text: data.element.textContent.substring(0, 50) + '...',
          normalizedEngagement: 0 // Will be calculated below
        };
      });
      
      // Calculate normalized engagement (0-1 scale)
      const maxTime = Math.max(...Object.values(result).map(d => d.timeSpent));
      if (maxTime > 0) {
        Object.values(result).forEach(data => {
          data.normalizedEngagement = data.timeSpent / maxTime;
        });
      }
      
      return result;
    }
  
    /**
     * Clean up resources
     */
    destroy() {
      // Stop tracking
      this.stopTracking();
      
      // Disconnect observer
      if (this.observer) {
        this.observer.disconnect();
      }
      
      // Remove data attributes
      this.paragraphs.forEach(p => {
        delete p.dataset.highlightId;
      });
      
      // Remove heatmap if it exists
      if (this.scrollbarCreated && this.options.heatmapContainer) {
        const container = typeof this.options.heatmapContainer === 'string'
          ? document.querySelector(this.options.heatmapContainer)
          : this.options.heatmapContainer;
        
        if (container) {
          container.innerHTML = '';
        }
      }
    }
  }
  
// Export for both Node.js and browser environments
if (typeof module !== 'undefined' && module.exports) {
  module.exports = HighlightTracker;
} else {
  window.HighlightTracker = HighlightTracker;
}