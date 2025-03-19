import { EventEmitter } from 'events';
import { interpolateRgb } from 'd3-interpolate';

// Polyfill check at the beginning
if (typeof IntersectionObserver === 'undefined') {
  require('intersection-observer');
}

if (typeof ResizeObserver === 'undefined') {
  require('resize-observer-polyfill');
}

/**
 * HighlightTracker - Tracks user engagement with paragraphs on a webpage
 * @extends EventEmitter
 */
class HighlightTracker extends EventEmitter {
  /**
   * Create a new HighlightTracker
   * @param {Object} options - Configuration options
   * @param {number} [options.minTimeThreshold=1000] - Minimum time threshold in ms
   * @param {number} [options.samplingRate=200] - Sampling rate in ms
   * @param {number} [options.visibilityThreshold=0.5] - Visibility threshold (0-1)
   * @param {Object} [options.colors] - Heatmap colors
   * @param {string} [options.colors.low='#C6E2FF'] - Color for low engagement
   * @param {string} [options.colors.medium='#4F97FF'] - Color for medium engagement
   * @param {string} [options.colors.high='#0047AB'] - Color for high engagement
   * @param {string} [options.heatmapContainer] - Selector for heatmap container
   */
  constructor(options = {}) {
    super();
    
    // Extended validation
    const validationSchema = {
      minTimeThreshold: { type: 'number', min: 0, default: 1000 },
      samplingRate: { type: 'number', min: 10, max: 1000, default: 200 },
      visibilityThreshold: { type: 'number', min: 0, max: 1, default: 0.5 },
      colors: { 
        type: 'object', 
        default: { 
          low: '#C6E2FF', 
          medium: '#4F97FF',
          high: '#0047AB' 
        } 
      },
      heatmapContainer: { type: 'string', default: null }
    };
    
    this.options = this.validateOptions(options, validationSchema);
    this.initializeState();
    this.setupEventListeners();
  }

  /**
   * Validate and normalize options against a schema
   * @param {Object} input - User provided options
   * @param {Object} schema - Validation schema
   * @returns {Object} - Validated options
   */
  validateOptions(input, schema) {
    const options = {};
    
    for (const [key, config] of Object.entries(schema)) {
      let value = input[key];
      
      // Handle nested objects
      if (config.type === 'object' && value) {
        if (typeof value !== 'object') {
          throw new TypeError(`${key} must be an object`);
        }
        value = { ...config.default, ...value };
      } else {
        value = value ?? config.default;
      }
      
      // Type validation for non-null values
      if (value !== null && config.type !== 'object' && typeof value !== config.type) {
        throw new TypeError(`${key} must be ${config.type}`);
      }
      
      // Range validation
      if (config.min !== undefined && value !== null && value < config.min) {
        throw new RangeError(`${key} cannot be less than ${config.min}`);
      }
      
      if (config.max !== undefined && value !== null && value > config.max) {
        throw new RangeError(`${key} cannot be greater than ${config.max}`);
      }
      
      options[key] = value;
    }
    
    return options;
  }

  /**
   * Initialize state variables
   * @private
   */
  initializeState() {
    this.paragraphs = [];
    this.engagementData = new WeakMap();
    this.observer = null;
    this.resizeObserver = null;
    this.rafId = null;
    this.tabVisible = true;
    this.isTracking = false;
    this.trackingStartTime = 0;
    this.lastProcessedIndex = 0;
    this.heatmapVisible = false;
    this.heatmapContainer = null;
    this.resizeTimeout = null;
    this.maxEngagement = 0;
  }

  /**
   * Set up global event listeners
   * @private
   */
  setupEventListeners() {
    this.handleVisibilityChange = this.handleVisibilityChange.bind(this);
    this.handleUnload = this.handleUnload.bind(this);
    
    document.addEventListener('visibilitychange', this.handleVisibilityChange);
    window.addEventListener('beforeunload', this.handleUnload);
  }

  /**
   * Handle visibility changes (tab focus/blur)
   * @private
   */
  handleVisibilityChange = () => {
    this.tabVisible = document.visibilityState === 'visible';
    
    if (this.tabVisible) {
      // Reset last update time to prevent counting time while tab was hidden
      const now = performance.now();
      this.paragraphs.forEach(p => {
        const data = this.engagementData.get(p);
        if (data) {
          data.lastUpdate = now;
        }
      });
    }
    
    this.emit('visibilityChange', { visible: this.tabVisible });
  };

  /**
   * Handle page unload
   * @private
   */
  handleUnload = () => {
    if (this.isTracking) {
      try {
        // Attempt to send final tracking data
        const data = this.exportData();
        this.emit('unload', { data });
      } catch (err) {
        // Silent fail on unload
      }
    }
  };

  /**
   * Initialize tracking on a container element
   * @param {string|HTMLElement} container - Container selector or element
   */
  init(container) {
    try {
      this.cleanupPrevious();
      const containerElement = this.validateContainer(container);
      this.paragraphs = this.getParagraphs(containerElement);
      this.initializeEngagementData();
      this.setupObservers();
      this.setupHeatmapContainer();
      this.emit('ready', { paragraphCount: this.paragraphs.length });
    } catch (error) {
      this.emit('error', { message: 'Initialization failed', error });
      throw error;
    }
  }

  /**
   * Clean up previous tracking session
   * @private
   */
  cleanupPrevious() {
    if (this.isTracking) {
      this.stopTracking();
    }
    
    if (this.observer) {
      this.observer.disconnect();
      this.observer = null;
    }
    
    if (this.resizeObserver) {
      this.resizeObserver.disconnect();
      this.resizeObserver = null;
    }
    
    // Clear heatmap elements but don't remove the container if it's user-provided
    if (this.heatmapContainer && !this.options.heatmapContainer) {
      this.heatmapContainer.remove();
      this.heatmapContainer = null;
    } else if (this.heatmapContainer) {
      this.heatmapContainer.innerHTML = '';
    }
    
    this.paragraphs = [];
    this.engagementData = new WeakMap();
    this.maxEngagement = 0;
  }

  /**
   * Validate container parameter
   * @param {string|HTMLElement} container - Container selector or element
   * @returns {HTMLElement} - Validated container element
   * @private
   */
  validateContainer(container) {
    let element;
    
    if (typeof container === 'string') {
      element = document.querySelector(container);
      if (!element) {
        throw new Error(`Container not found: ${container}`);
      }
    } else if (container instanceof HTMLElement) {
      element = container;
    } else {
      throw new TypeError('Container must be a CSS selector or HTMLElement');
    }
    
    return element;
  }

  /**
   * Find all paragraphs within container
   * @param {HTMLElement} container - Container element
   * @returns {HTMLElement[]} - Array of paragraph elements
   * @private
   */
  getParagraphs(container) {
    // Select paragraphs and add unique IDs if not present
    const paragraphs = Array.from(container.querySelectorAll('p'));
    
    if (paragraphs.length === 0) {
      this.emit('warning', { message: 'No paragraphs found in container' });
    }
    
    // Assign IDs for tracking
    paragraphs.forEach((p, index) => {
      if (!p.dataset.highlightId) {
        p.dataset.highlightId = `p-${Date.now()}-${index}`;
      }
    });
    
    return paragraphs;
  }

  /**
   * Initialize engagement data for each paragraph
   * @private
   */
  initializeEngagementData() {
    this.paragraphs.forEach(p => {
      this.engagementData.set(p, {
        visibleRatio: 0,
        timeSpent: 0,
        weightedTime: 0,
        lastUpdate: null,
        inView: false
      });
    });
  }

  /**
   * Setup the heatmap container based on options
   * @private
   */
  setupHeatmapContainer() {
    if (this.options.heatmapContainer) {
      const container = document.querySelector(this.options.heatmapContainer);
      if (!container) {
        throw new Error(`Heatmap container not found: ${this.options.heatmapContainer}`);
      }
      this.heatmapContainer = container;
      this.heatmapContainer.style.position = 'relative';
      this.heatmapContainer.innerHTML = '';
    }
  }

  /**
   * Set up IntersectionObserver and ResizeObserver
   * @private
   */
  setupObservers() {
    // Intersection Observer with dynamic thresholds
    try {
      this.observer = new IntersectionObserver(this.handleIntersection, {
        root: null,
        rootMargin: '0px',
        threshold: this.calculateThresholds()
      });

      // Resize Observer for responsive tracking
      this.resizeObserver = new ResizeObserver(this.handleResize);
      this.resizeObserver.observe(document.documentElement);

      // Add Mutation Observer for DOM changes
      this.mutationObserver = new MutationObserver((mutations) => {
        mutations.forEach((mutation) => {
          if (mutation.type === 'childList') {
            this.handleDOMChanges(mutation);
          }
        });
      });

      this.mutationObserver.observe(document.body, {
        childList: true,
        subtree: true
      });

      this.paragraphs.forEach(p => {
        try {
          this.observer.observe(p);
        } catch (error) {
          this.emit('error', { element: p, error });
        }
      });
    } catch (error) {
      this.emit('error', { message: 'Failed to create observers', error });
      throw error;
    }
  }

  /**
   * Calculate thresholds for IntersectionObserver
   * @returns {number[]} - Array of threshold values
   * @private
   */
  calculateThresholds() {
    // Create 10 threshold points from 0 to 1
    const thresholds = [];
    for (let i = 0; i <= 10; i++) {
      thresholds.push(i / 10);
    }
    return thresholds;
  }

  /**
   * Handle intersection events
   * @param {IntersectionObserverEntry[]} entries - Intersection entries
   * @private
   */
  handleIntersection = (entries) => {
    if (!this.tabVisible) return;
    
    const now = performance.now();
    
    entries.forEach(entry => {
      const data = this.engagementData.get(entry.target);
      if (!data) return;

      // Track exact visible ratio
      data.visibleRatio = entry.intersectionRatio;
      data.inView = entry.isIntersecting;
      
      // Calculate weighted time contribution
      if (data.lastUpdate) {
        const delta = now - data.lastUpdate;
        if (data.inView && this.isTracking) {
          data.timeSpent += delta;
          data.weightedTime += delta * data.visibleRatio;
          
          // Update max engagement for scaling
          if (data.timeSpent > this.maxEngagement) {
            this.maxEngagement = data.timeSpent;
          }
        }
      }
      
      data.lastUpdate = now;
    });
  };

  /**
   * Handle resize events
   * @private
   */
  handleResize = () => {
    clearTimeout(this.resizeTimeout);
    this.resizeTimeout = setTimeout(() => {
      if (this.heatmapVisible) {
        this.updateHeatmap();
      }
    }, 300);
  };

  /**
   * Start tracking engagement
   */
  startTracking() {
    if (this.isTracking) return;
    
    this.isTracking = true;
    this.trackingStartTime = performance.now();
    
    // Update all timestamps to prevent counting time before tracking started
    this.paragraphs.forEach(p => {
      const data = this.engagementData.get(p);
      if (data) {
        data.lastUpdate = this.trackingStartTime;
      }
    });
    
    this.trackingFrame();
    this.emit('trackingStarted');
  }

  /**
   * Stop tracking engagement
   */
  stopTracking() {
    if (!this.isTracking) return;
    
    this.isTracking = false;
    cancelAnimationFrame(this.rafId);
    this.rafId = null;
    
    this.emit('trackingStopped', {
      duration: performance.now() - this.trackingStartTime
    });
  }

  /**
   * Animation frame handler for tracking
   * @private
   */
  trackingFrame = () => {
    if (!this.isTracking || !this.tabVisible) {
      this.rafId = requestAnimationFrame(this.trackingFrame);
      return;
    }
    
    // Dynamically adjust batch size based on frame time
    const targetFrameTime = 16; // ms
    const measuredFrameTime = performance.now() - this.lastFrameTime;
    const batchSize = Math.min(Math.floor(5 * (targetFrameTime / measuredFrameTime)), this.paragraphs.length);
    this.processBatch(batchSize);
    
    this.rafId = requestAnimationFrame(this.trackingFrame);
  };

  /**
   * Process a batch of paragraphs for performance
   * @param {number} batchSize - Number of paragraphs to process
   * @private
   */
  processBatch(batchSize) {
    const now = performance.now();
    
    for (let i = 0; i < batchSize; i++) {
      const index = (this.lastProcessedIndex + i) % this.paragraphs.length;
      const paragraph = this.paragraphs[index];
      const data = this.engagementData.get(paragraph);
      
      if (!data) continue;
      
      // Update time calculations
      if (data.visibleRatio >= this.options.visibilityThreshold && data.lastUpdate) {
        const delta = now - data.lastUpdate;
        data.timeSpent += delta;
        data.weightedTime += delta * data.visibleRatio;
        
        // Update max engagement for scaling
        if (data.timeSpent > this.maxEngagement) {
          this.maxEngagement = data.timeSpent;
        }
      }
      
      data.lastUpdate = now;
    }
    
    this.lastProcessedIndex = (this.lastProcessedIndex + batchSize) % this.paragraphs.length;
  }

  /**
   * Create a visual heatmap of engagement
   */
  createHeatmap() {
    if (!this.heatmapContainer) {
      // Create container if not provided
      this.heatmapContainer = document.createElement('div');
      this.heatmapContainer.className = 'highlight-tracker-heatmap';
      this.heatmapContainer.style.cssText = `
        position: fixed;
        top: 0;
        right: 0;
        width: 20px;
        height: 100%;
        z-index: 9999;
      `;
      document.body.appendChild(this.heatmapContainer);
    }
    
    this.updateHeatmap();
    this.heatmapVisible = true;
    
    this.emit('heatmapCreated');
  }

  /**
   * Buffer heatmap updates using requestAnimationFrame
   * @private
   */
  updateHeatmap() {
    if (this.heatmapUpdateRequest) return;
    this.heatmapUpdateRequest = requestAnimationFrame(() => {
      this._updateHeatmap();
      this.heatmapUpdateRequest = null;
    });
  }

  /**
   * Internal method to update the heatmap
   * @private
   */
  _updateHeatmap() {
    if (!this.heatmapContainer) return;
    
    // Clear existing segments
    this.heatmapContainer.innerHTML = '';
    
    // Calculate document height for positioning
    const docHeight = document.documentElement.scrollHeight;
    
    // Create fragments for efficient DOM updates
    const fragment = document.createDocumentFragment();
    
    // Sort paragraphs by their position in the document
    const sortedParagraphs = [...this.paragraphs]
      .sort((a, b) => {
        const aRect = a.getBoundingClientRect();
        const bRect = b.getBoundingClientRect();
        return (aRect.top + window.scrollY) - (bRect.top + window.scrollY);
      });
    
    sortedParagraphs.forEach(paragraph => {
      const data = this.engagementData.get(paragraph);
      if (!data) return;
      
      const rect = paragraph.getBoundingClientRect();
      const paragraphTop = rect.top + window.scrollY;
      const paragraphHeight = rect.height;
      
      // Calculate position in heatmap
      const relativePosition = paragraphTop / docHeight;
      const relativeHeight = paragraphHeight / docHeight;
      
      // Ensure minimum height for visibility
      const segmentHeight = Math.max(relativeHeight * 100, 1);
      
      // Calculate intensity based on time spent
      let intensity = 0;
      if (this.maxEngagement > 0) {
        intensity = data.timeSpent / this.maxEngagement;
      }
      
      // Determine color based on intensity
      let color;
      if (intensity < 0.33) {
        color = this.options.colors.low;
      } else if (intensity < 0.66) {
        color = this.options.colors.medium;
      } else {
        color = this.options.colors.high;
      }
      
      const segment = document.createElement('div');
      segment.className = 'heatmap-segment';
      segment.dataset.paragraphId = paragraph.dataset.highlightId;
      segment.style.cssText = `
        position: absolute;
        top: ${relativePosition * 100}%;
        left: 0;
        width: 100%;
        height: ${segmentHeight}%;
        background-color: ${color};
        cursor: pointer;
        transition: opacity 0.2s;
      `;
    // Add click handler to scroll to paragraph
    segment.addEventListener('click', () => {
      paragraph.scrollIntoView({ behavior: 'smooth', block: 'start' });
      // Flash highlight effect
      const originalBg = paragraph.style.backgroundColor;
      paragraph.style.backgroundColor = 'rgba(79, 151, 255, 0.2)';
      setTimeout(() => {
        paragraph.style.backgroundColor = originalBg;
      }, 1500);
    });
    
    // Add tooltip with engagement data
    segment.title = `${Math.round(data.timeSpent)}ms spent on this paragraph`;
    
    fragment.appendChild(segment);
  });
  
  // Add current viewport indicator
  const viewportIndicator = document.createElement('div');
  viewportIndicator.className = 'viewport-indicator';
  viewportIndicator.style.cssText = `
    position: absolute;
    top: ${window.scrollY / docHeight * 100}%;
    left: -5px;
    width: 5px;
    height: ${window.innerHeight / docHeight * 100}%;
    background-color: rgba(255, 255, 255, 0.7);
    border: 1px solid #333;
    pointer-events: none;
  `;
  fragment.appendChild(viewportIndicator);
  
  // Efficient DOM update
  this.heatmapContainer.appendChild(fragment);
  
  // Update viewport indicator on scroll
  const updateViewportIndicator = () => {
    const indicator = this.heatmapContainer.querySelector('.viewport-indicator');
    if (indicator) {
      indicator.style.top = `${window.scrollY / docHeight * 100}%`;
    }
  };
  
  // Add scroll listener if not already added
  if (!this._scrollListenerAdded) {
    window.addEventListener('scroll', updateViewportIndicator, { passive: true });
    this._scrollListenerAdded = true;
  }
}

  /**
   * Hide the heatmap
   */
  hideHeatmap() {
    if (this.heatmapContainer) {
      if (this.options.heatmapContainer) {
        // Clear container if user-provided
        this.heatmapContainer.innerHTML = '';
      } else {
        // Remove container if we created it
        this.heatmapContainer.style.display = 'none';
      }
      this.heatmapVisible = false;
      this.emit('heatmapHidden');
    }
  }

  /**
   * Export engagement data
   * @returns {Object} - Engagement data keyed by paragraph ID
   */
  exportData() {
    const result = {};
    const now = performance.now();
    
    this.paragraphs.forEach(element => {
      const data = this.engagementData.get(element);
      if (!data) return;
      
      // Final time update
      if (data.lastUpdate && this.isTracking) {
        const delta = now - data.lastUpdate;
        if (data.visibleRatio >= this.options.visibilityThreshold) {
          data.timeSpent += delta * data.visibleRatio;
          data.weightedTime += delta * data.visibleRatio;
        }
      }
      
      // Apply minimum threshold
      const adjustedTime = Math.max(
        data.timeSpent - this.options.minTimeThreshold,
        0
      );
      
      result[element.dataset.highlightId] = {
        rawTime: Math.round(data.timeSpent),
        adjustedTime: Math.round(adjustedTime),
        weightedTime: Math.round(data.weightedTime),
        text: this.sanitizeText(element.textContent),
        visibleRatio: data.visibleRatio,
        element: {
          tagName: element.tagName,
          className: element.className
        }
      };
    });
    
    return result;
  }

  /**
   * Sanitize text for safe export
   * @param {string} text - Raw text
   * @returns {string} - Sanitized text
   * @private
   */
  sanitizeText(text) {
    if (!text) return '';
    
    // Basic XSS protection
    return text.substring(0, 100)
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .trim();
  }

  /**
   * Clean up all resources and event listeners
   */
  destroy() {
    try {
      // Stop tracking
      this.stopTracking();
      
      // Clean up observers
      if (this.observer) {
        this.observer.disconnect();
        this.observer = null;
      }
      
      if (this.resizeObserver) {
        this.resizeObserver.disconnect();
        this.resizeObserver = null;
      }

      // Add cleanup for mutation observer
      if (this.mutationObserver) {
        this.mutationObserver.disconnect();
        this.mutationObserver = null;
      }
      
      // Remove event listeners
      document.removeEventListener('visibilitychange', this.handleVisibilityChange);
      window.removeEventListener('beforeunload', this.handleUnload);
      
      if (this._scrollListenerAdded) {
        window.removeEventListener('scroll', this.updateViewportIndicator);
      }
      
      // Remove DOM elements - only if we created it
      if (this.heatmapContainer && !this.options.heatmapContainer) {
        this.heatmapContainer.remove();
      } else if (this.heatmapContainer) {
        this.heatmapContainer.innerHTML = '';
      }
      this.heatmapContainer = null;
      
      // Clear timeouts
      clearTimeout(this.resizeTimeout);
      
      // Clear references
      this.paragraphs = [];
      this.engagementData = new WeakMap();
      
      // Cancel any pending heatmap updates
      if (this.heatmapUpdateRequest) {
        cancelAnimationFrame(this.heatmapUpdateRequest);
        this.heatmapUpdateRequest = null;
      }
      
      this.emit('destroyed');
    } catch (error) {
      this.emit('error', { message: 'Error during cleanup', error });
    }
  }

  /**
   * Handle DOM mutations that might affect tracked paragraphs
   * @param {MutationRecord} mutation - The mutation record
   * @private
   */
  handleDOMChanges(mutation) {
    // Check added nodes for new paragraphs
    mutation.addedNodes.forEach(node => {
      if (node.nodeName === 'P') {
        // Add new paragraph to tracking
        const id = `p-${Date.now()}-${this.paragraphs.length}`;
        node.dataset.highlightId = id;
        this.paragraphs.push(node);
        this.engagementData.set(node, {
          visibleRatio: 0,
          timeSpent: 0,
          weightedTime: 0,
          lastUpdate: this.isTracking ? performance.now() : null,
          inView: false
        });
        this.observer.observe(node);
      }
    });

    // Check removed nodes for tracked paragraphs
    mutation.removedNodes.forEach(node => {
      if (node.nodeName === 'P' && node.dataset.highlightId) {
        // Remove paragraph from tracking
        const index = this.paragraphs.findIndex(p => p.dataset.highlightId === node.dataset.highlightId);
        if (index !== -1) {
          this.paragraphs.splice(index, 1);
          this.engagementData.delete(node);
        }
      }
    });

    // Update heatmap if visible using buffered update
    if (this.heatmapVisible) {
      this.updateHeatmap();
    }
  }
}

export default HighlightTracker;