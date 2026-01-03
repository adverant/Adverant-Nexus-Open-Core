#!/usr/bin/env ts-node
/**
 * Seed Widget Showcase Data Script
 *
 * This script seeds the database with data patterns specifically designed to showcase
 * all geo widgets in the Data Explorer:
 *
 * - GeofenceMonitor: Security zones, safety zones, operational areas
 * - FleetTracker: Vehicle/asset locations with movement patterns
 * - HeatmapLayer: Clustered activity data for density visualization
 * - GeoAIChatPanel: Rich content for AI Q&A
 * - GeoMap: Diverse marker types and locations
 * - Overlay Layers: Satellite, LiDAR, orthomosaic, hyperspectral, thermal imagery
 *
 * Overlay Data Sources:
 * - NASA GIBS (MODIS, VIIRS Night Lights)
 * - Copernicus Sentinel-1/2 (SAR, Optical)
 * - OpenAerialMap (Drone/Orthomosaic)
 * - USGS 3DEP LiDAR
 * - Umbra SAR (High-res commercial)
 * - USDA NAIP (Aerial)
 * - Landsat 8/9 (Thermal TIRS)
 * - Wyvern (Hyperspectral)
 * - Copernicus DEM (Elevation)
 *
 * Usage:
 *   ts-node src/scripts/seed-widget-showcase-data.ts
 *
 * Requirements:
 *   - PostgreSQL database running
 *   - DATABASE_URL environment variable set
 */

import { Pool } from 'pg';
import { config } from 'dotenv';

// Load environment variables
config();

// ============================================================================
// TYPES
// ============================================================================

interface WidgetShowcaseMemory {
  content: string;
  tags: string[];
  metadata: Record<string, unknown>;
}

// ============================================================================
// GEOFENCE SHOWCASE DATA
// ============================================================================

const GEOFENCE_ZONES: WidgetShowcaseMemory[] = [
  // Security Zones
  {
    content: 'Downtown Restricted Security Zone\nHigh-security perimeter with 24/7 monitoring. Entry requires authorization badge.',
    tags: ['zone', 'geofence', 'security', 'restricted', 'circle', 'radius'],
    metadata: {
      latitude: '40.7128',
      longitude: '-74.0060',
      placeName: 'Downtown Security Zone',
      city: 'New York',
      country: 'USA',
      source: 'widget-showcase',
      type: 'geofence',
      geofenceType: 'circle',
      radius: 500,
      category: 'security',
    },
  },
  {
    content: 'Federal Building Security Perimeter\nCritical infrastructure protection zone. All access logged.',
    tags: ['zone', 'geofence', 'security', 'restricted', 'polygon'],
    metadata: {
      latitude: '40.7614',
      longitude: '-73.9776',
      placeName: 'Federal Building',
      city: 'New York',
      country: 'USA',
      source: 'widget-showcase',
      type: 'geofence',
      geofenceType: 'polygon',
      category: 'security',
    },
  },
  // Safety Zones
  {
    content: 'Lincoln Elementary School Safety Zone\n300m radius protection area. Speed limit 20mph.',
    tags: ['zone', 'geofence', 'safety', 'school', 'circle', 'radius'],
    metadata: {
      latitude: '40.7282',
      longitude: '-73.9942',
      placeName: 'Lincoln Elementary',
      city: 'New York',
      country: 'USA',
      source: 'widget-showcase',
      type: 'geofence',
      geofenceType: 'circle',
      radius: 300,
      category: 'safety',
    },
  },
  {
    content: 'Hospital Emergency Zone\nNo parking, emergency vehicles only. 24/7 access required.',
    tags: ['zone', 'geofence', 'safety', 'hospital', 'polygon'],
    metadata: {
      latitude: '40.7412',
      longitude: '-74.0018',
      placeName: 'NYC General Hospital',
      city: 'New York',
      country: 'USA',
      source: 'widget-showcase',
      type: 'geofence',
      geofenceType: 'polygon',
      category: 'safety',
    },
  },
  // Operational Zones
  {
    content: 'Main Warehouse Distribution Zone\nLogistics hub for downtown deliveries. 8am-6pm operations.',
    tags: ['zone', 'geofence', 'operational', 'warehouse', 'polygon'],
    metadata: {
      latitude: '40.7200',
      longitude: '-74.0150',
      placeName: 'Central Warehouse',
      city: 'New York',
      country: 'USA',
      source: 'widget-showcase',
      type: 'geofence',
      geofenceType: 'polygon',
      category: 'operational',
    },
  },
  {
    content: 'Port Authority Loading Zone\nCommercial vehicle staging area. Permit required.',
    tags: ['zone', 'geofence', 'operational', 'loading', 'circle', 'radius'],
    metadata: {
      latitude: '40.7500',
      longitude: '-74.0000',
      placeName: 'Port Authority',
      city: 'New York',
      country: 'USA',
      source: 'widget-showcase',
      type: 'geofence',
      geofenceType: 'circle',
      radius: 400,
      category: 'operational',
    },
  },
  // Marketing Zones
  {
    content: 'Times Square Retail District\nHigh-traffic shopping area. Perfect for promotions.',
    tags: ['zone', 'geofence', 'marketing', 'retail', 'polygon'],
    metadata: {
      latitude: '40.7580',
      longitude: '-73.9855',
      placeName: 'Times Square',
      city: 'New York',
      country: 'USA',
      source: 'widget-showcase',
      type: 'geofence',
      geofenceType: 'polygon',
      category: 'marketing',
    },
  },
  // Regulatory Zones
  {
    content: 'Highway 278 Commercial Corridor\nRestricted lane for commercial vehicles 6am-9am.',
    tags: ['zone', 'geofence', 'regulatory', 'corridor', 'route'],
    metadata: {
      latitude: '40.7180',
      longitude: '-74.0080',
      placeName: 'Highway 278',
      city: 'New York',
      country: 'USA',
      source: 'widget-showcase',
      type: 'geofence',
      geofenceType: 'corridor',
      category: 'regulatory',
    },
  },
];

// ============================================================================
// FLEET/VEHICLE SHOWCASE DATA
// ============================================================================

const FLEET_ASSETS: WidgetShowcaseMemory[] = [
  // Trucks
  {
    content: 'Delivery Truck 101 - Active Route\nCurrently delivering to 500 Main Street. ETA 25 minutes.',
    tags: ['vehicle', 'truck', 'delivery', 'active', 'fleet'],
    metadata: {
      latitude: '40.7128',
      longitude: '-74.0060',
      vehicleId: 'T101',
      vehicleName: 'Truck 101',
      vehicleType: 'truck',
      driver: 'John Smith',
      status: 'en-route',
      speed: 45,
      heading: 270,
      fuel: 72,
      currentTask: 'Delivery to 500 Main St',
      source: 'widget-showcase',
      type: 'vehicle',
    },
  },
  {
    content: 'Heavy Truck 108 - Maintenance\nScheduled oil change at service center.',
    tags: ['vehicle', 'truck', 'maintenance', 'fleet'],
    metadata: {
      latitude: '40.7080',
      longitude: '-74.0200',
      vehicleId: 'T108',
      vehicleName: 'Truck 108',
      vehicleType: 'truck',
      driver: 'Sarah Davis',
      status: 'maintenance',
      speed: 0,
      heading: 0,
      fuel: 90,
      source: 'widget-showcase',
      type: 'vehicle',
    },
  },
  // Vans
  {
    content: 'Van 205 - Downtown Loop\nRegular route through midtown.',
    tags: ['vehicle', 'van', 'delivery', 'active', 'fleet'],
    metadata: {
      latitude: '40.7200',
      longitude: '-74.0150',
      vehicleId: 'V205',
      vehicleName: 'Van 205',
      vehicleType: 'van',
      driver: 'Maria Garcia',
      status: 'active',
      speed: 32,
      heading: 45,
      fuel: 85,
      currentTask: 'Route: Downtown Loop',
      source: 'widget-showcase',
      type: 'vehicle',
    },
  },
  {
    content: 'Express Van 210 - Priority Delivery\nUrgent package for corporate client.',
    tags: ['vehicle', 'van', 'express', 'priority', 'fleet'],
    metadata: {
      latitude: '40.7250',
      longitude: '-74.0080',
      vehicleId: 'V210',
      vehicleName: 'Van 210',
      vehicleType: 'van',
      driver: 'Tom Wilson',
      status: 'en-route',
      speed: 55,
      heading: 90,
      fuel: 60,
      currentTask: 'Express delivery - Priority',
      alerts: ['speeding'],
      source: 'widget-showcase',
      type: 'vehicle',
    },
  },
  // Cars
  {
    content: 'Supervisor Car 312 - Idle\nWaiting for next assignment at central station.',
    tags: ['vehicle', 'car', 'supervisor', 'idle', 'fleet'],
    metadata: {
      latitude: '40.7150',
      longitude: '-74.0100',
      vehicleId: 'C312',
      vehicleName: 'Car 312',
      vehicleType: 'car',
      driver: 'Mike Johnson',
      status: 'idle',
      speed: 0,
      heading: 180,
      fuel: 45,
      alerts: ['fuel-low'],
      source: 'widget-showcase',
      type: 'vehicle',
    },
  },
  {
    content: 'Company Car 318 - Offline\nNo GPS signal - parked at employee residence.',
    tags: ['vehicle', 'car', 'offline', 'fleet'],
    metadata: {
      latitude: '40.7220',
      longitude: '-74.0120',
      vehicleId: 'C318',
      vehicleName: 'Car 318',
      vehicleType: 'car',
      driver: 'Unassigned',
      status: 'offline',
      speed: 0,
      heading: 0,
      fuel: 95,
      alerts: ['offline'],
      source: 'widget-showcase',
      type: 'vehicle',
    },
  },
  // Motorcycles
  {
    content: 'Courier Bike 401 - Document Pickup\nQuick delivery for legal documents.',
    tags: ['vehicle', 'motorcycle', 'courier', 'active', 'fleet'],
    metadata: {
      latitude: '40.7180',
      longitude: '-74.0020',
      vehicleId: 'M401',
      vehicleName: 'Motorcycle 401',
      vehicleType: 'motorcycle',
      driver: 'Alex Chen',
      status: 'active',
      speed: 28,
      heading: 315,
      fuel: 80,
      currentTask: 'Courier - Document pickup',
      source: 'widget-showcase',
      type: 'vehicle',
    },
  },
  // Buses
  {
    content: 'Shuttle Bus 501 - Route 42 Southbound\nPublic transit shuttle service.',
    tags: ['vehicle', 'bus', 'transit', 'active', 'fleet'],
    metadata: {
      latitude: '40.7100',
      longitude: '-74.0180',
      vehicleId: 'B501',
      vehicleName: 'Bus 501',
      vehicleType: 'bus',
      driver: 'Linda Brown',
      status: 'en-route',
      speed: 25,
      heading: 135,
      fuel: 55,
      currentTask: 'Route 42 - Southbound',
      source: 'widget-showcase',
      type: 'vehicle',
    },
  },
];

// ============================================================================
// HEATMAP CLUSTER DATA (High-density activity areas)
// ============================================================================

function generateHeatmapClusters(): WidgetShowcaseMemory[] {
  const clusters: WidgetShowcaseMemory[] = [];

  // Manhattan high-activity clusters
  const manhattanCenters = [
    { lat: 40.7580, lng: -73.9855, name: 'Times Square', count: 25 },
    { lat: 40.7527, lng: -73.9772, name: 'Grand Central', count: 20 },
    { lat: 40.7484, lng: -73.9857, name: 'Empire State Building', count: 18 },
    { lat: 40.7614, lng: -73.9776, name: 'Rockefeller Center', count: 15 },
    { lat: 40.7128, lng: -74.0060, name: 'Financial District', count: 22 },
    { lat: 40.7282, lng: -73.9942, name: 'Greenwich Village', count: 12 },
  ];

  manhattanCenters.forEach((center) => {
    for (let i = 0; i < center.count; i++) {
      // Add slight random offset for clustering effect
      const latOffset = (Math.random() - 0.5) * 0.008;
      const lngOffset = (Math.random() - 0.5) * 0.008;

      const activities = [
        'Customer visit logged',
        'Delivery completed',
        'Service call finished',
        'Sales meeting held',
        'Installation done',
        'Inspection completed',
        'Pickup confirmed',
        'Survey taken',
      ];

      const activity = activities[Math.floor(Math.random() * activities.length)];
      const hoursAgo = Math.floor(Math.random() * 48);

      clusters.push({
        content: `${activity} near ${center.name}. ${hoursAgo}h ago.`,
        tags: ['activity', 'heatmap', 'location', 'field-work'],
        metadata: {
          latitude: (center.lat + latOffset).toFixed(6),
          longitude: (center.lng + lngOffset).toFixed(6),
          placeName: center.name,
          city: 'New York',
          country: 'USA',
          source: 'widget-showcase',
          type: 'activity',
          activityType: activity.split(' ')[0].toLowerCase(),
          weight: Math.random() * 2 + 0.5, // Heatmap weight
          timestamp: new Date(Date.now() - hoursAgo * 3600000).toISOString(),
        },
      });
    }
  });

  return clusters;
}

// ============================================================================
// AI CHAT SHOWCASE DATA (Rich content for Q&A)
// ============================================================================

// ============================================================================
// OVERLAY DATA (Drone, Orthomosaic, Satellite, LiDAR)
// ============================================================================

const OVERLAY_DATA: WidgetShowcaseMemory[] = [
  // NASA GIBS Satellite Overlays
  {
    content: 'NASA GIBS MODIS True Color Satellite Imagery\nDaily updated global satellite imagery from Terra/Aqua satellites. Supports WMTS for web map overlay.',
    tags: ['overlay', 'satellite', 'modis', 'nasa', 'imagery', 'layer'],
    metadata: {
      latitude: '40.7128',
      longitude: '-74.0060',
      city: 'Global',
      country: 'Global',
      source: 'widget-showcase',
      type: 'overlay',
      overlayType: 'satellite',
      overlayService: 'NASA GIBS',
      layerName: 'MODIS_Terra_CorrectedReflectance_TrueColor',
      wmtsUrl: 'https://gibs.earthdata.nasa.gov/wmts/epsg3857/best/MODIS_Terra_CorrectedReflectance_TrueColor/default/{Time}/GoogleMapsCompatible_Level9/{z}/{y}/{x}.jpg',
      format: 'WMTS',
      resolution: '250m',
      updateFrequency: 'Daily',
      documentation: 'https://nasa-gibs.github.io/gibs-api-docs/',
    },
  },
  {
    content: 'NASA VIIRS Night Lights (Black Marble)\nGlobal night-time lights imagery showing human settlement patterns and electricity access.',
    tags: ['overlay', 'satellite', 'viirs', 'nightlights', 'nasa', 'imagery', 'layer'],
    metadata: {
      latitude: '40.7580',
      longitude: '-73.9855',
      city: 'Global',
      country: 'Global',
      source: 'widget-showcase',
      type: 'overlay',
      overlayType: 'nightlights',
      overlayService: 'NASA GIBS',
      layerName: 'VIIRS_SNPP_DayNightBand_ENCC',
      wmtsUrl: 'https://gibs.earthdata.nasa.gov/wmts/epsg3857/best/VIIRS_SNPP_DayNightBand_ENCC/default/{Time}/GoogleMapsCompatible_Level8/{z}/{y}/{x}.png',
      format: 'WMTS',
      resolution: '500m',
      updateFrequency: 'Monthly',
      documentation: 'https://nasa-gibs.github.io/gibs-api-docs/',
    },
  },
  // Sentinel-2 Optical
  {
    content: 'Copernicus Sentinel-2 Multispectral Imagery\n10m resolution optical satellite imagery. Updated every 5 days. Supports NDVI, false color, and true color composites.',
    tags: ['overlay', 'satellite', 'sentinel', 'optical', 'multispectral', 'imagery', 'layer'],
    metadata: {
      latitude: '40.7614',
      longitude: '-73.9776',
      city: 'Global',
      country: 'Global',
      source: 'widget-showcase',
      type: 'overlay',
      overlayType: 'optical',
      overlayService: 'Sentinel Hub',
      layerName: 'Sentinel-2 L2A True Color',
      wmsUrl: 'https://services.sentinel-hub.com/ogc/wms/{instance_id}',
      format: 'WMS',
      resolution: '10m',
      updateFrequency: '5 days',
      bands: ['B02', 'B03', 'B04', 'B08'],
      documentation: 'https://www.sentinel-hub.com/develop/api/',
    },
  },
  // Sentinel-1 SAR
  {
    content: 'Copernicus Sentinel-1 SAR Radar Imagery\nAll-weather, day/night radar imagery. Ideal for surface deformation monitoring and land cover change detection.',
    tags: ['overlay', 'satellite', 'sentinel', 'sar', 'radar', 'imagery', 'layer'],
    metadata: {
      latitude: '40.7500',
      longitude: '-74.0000',
      city: 'Global',
      country: 'Global',
      source: 'widget-showcase',
      type: 'overlay',
      overlayType: 'sar',
      overlayService: 'Copernicus',
      layerName: 'Sentinel-1 GRD',
      format: 'COG',
      resolution: '10m',
      updateFrequency: '6 days',
      documentation: 'https://dataspace.copernicus.eu/',
    },
  },
  // OpenAerialMap Drone/Orthomosaic
  {
    content: 'OpenAerialMap Drone Orthomosaic - NYC Area\nCommunity-sourced aerial imagery from drone flights. High resolution (<1m) orthomosaic coverage.',
    tags: ['overlay', 'drone', 'orthomosaic', 'aerial', 'oam', 'imagery', 'layer'],
    metadata: {
      latitude: '40.7282',
      longitude: '-73.9942',
      city: 'New York',
      country: 'USA',
      source: 'widget-showcase',
      type: 'overlay',
      overlayType: 'orthomosaic',
      overlayService: 'OpenAerialMap',
      apiUrl: 'https://api.openaerialmap.org/meta',
      stacUrl: 'https://stac.openaerialmap.org/v2/',
      format: 'TMS/STAC',
      resolution: '0.1m-1m',
      license: 'Open License',
      documentation: 'https://docs.openaerialmap.org/',
    },
  },
  // USGS LiDAR
  {
    content: 'USGS 3DEP LiDAR Point Cloud Data - Manhattan\nHigh-density LiDAR point cloud data for terrain and building modeling. Available via AWS S3.',
    tags: ['overlay', 'lidar', 'pointcloud', 'terrain', '3dep', 'usgs', 'layer'],
    metadata: {
      latitude: '40.7580',
      longitude: '-73.9855',
      city: 'New York',
      country: 'USA',
      source: 'widget-showcase',
      type: 'overlay',
      overlayType: 'lidar',
      overlayService: 'USGS 3DEP',
      s3Url: 's3://usgs-lidar-public/USGS_LPC_NY_NewYorkCity_2017_LAS/',
      format: 'EPT/LAZ',
      resolution: '~1 point/m²',
      coverage: 'Continental US',
      awsRegistry: 'https://registry.opendata.aws/usgs-lidar/',
      documentation: 'https://www.usgs.gov/3d-elevation-program',
    },
  },
  // Umbra SAR High-Res
  {
    content: 'Umbra SAR High-Resolution Radar Imagery\n16cm resolution commercial SAR imagery. Sample datasets available for research and development.',
    tags: ['overlay', 'sar', 'radar', 'highres', 'umbra', 'imagery', 'layer'],
    metadata: {
      latitude: '40.7074',
      longitude: '-74.0113',
      city: 'Various',
      country: 'Global',
      source: 'widget-showcase',
      type: 'overlay',
      overlayType: 'sar',
      overlayService: 'Umbra',
      dataUrl: 'https://umbra.space/open-data/',
      awsRegistry: 'https://registry.opendata.aws/umbra-open-data/',
      format: 'GeoTIFF',
      resolution: '16cm-1m',
      license: 'Research/Development',
      documentation: 'https://umbra.space/',
    },
  },
  // NAIP Aerial
  {
    content: 'NAIP Aerial Imagery - US Coverage\nNational Agriculture Imagery Program provides 0.6m-1m resolution aerial imagery for the continental US.',
    tags: ['overlay', 'aerial', 'naip', 'orthophoto', 'usda', 'imagery', 'layer'],
    metadata: {
      latitude: '40.7412',
      longitude: '-74.0018',
      city: 'US Coverage',
      country: 'USA',
      source: 'widget-showcase',
      type: 'overlay',
      overlayType: 'aerial',
      overlayService: 'USDA NAIP',
      awsUrl: 's3://naip-visualization/',
      format: 'COG/MRF',
      resolution: '0.6m-1m',
      coverage: 'Continental US',
      updateCycle: '2-3 years',
      awsRegistry: 'https://registry.opendata.aws/naip/',
      documentation: 'https://www.fsa.usda.gov/programs-and-services/aerial-photography/imagery-programs/naip-imagery/',
    },
  },
  // Landsat Thermal
  {
    content: 'Landsat 8/9 Thermal Infrared (TIRS) Imagery\nThermal band imagery at 100m resolution for land surface temperature analysis.',
    tags: ['overlay', 'satellite', 'thermal', 'landsat', 'tirs', 'temperature', 'layer'],
    metadata: {
      latitude: '40.7200',
      longitude: '-74.0150',
      city: 'Global',
      country: 'Global',
      source: 'widget-showcase',
      type: 'overlay',
      overlayType: 'thermal',
      overlayService: 'USGS Landsat',
      earthExplorerUrl: 'https://earthexplorer.usgs.gov/',
      format: 'GeoTIFF',
      resolution: '100m',
      bands: ['B10', 'B11'],
      updateFrequency: '16 days',
      documentation: 'https://www.usgs.gov/landsat-missions',
    },
  },
  // Hyperspectral
  {
    content: 'Wyvern Hyperspectral Open Data\nHyperspectral satellite imagery for vegetation health, mineral exploration, and environmental monitoring.',
    tags: ['overlay', 'hyperspectral', 'satellite', 'wyvern', 'spectral', 'imagery', 'layer'],
    metadata: {
      latitude: '40.7180',
      longitude: '-74.0080',
      city: 'Various',
      country: 'Global',
      source: 'widget-showcase',
      type: 'overlay',
      overlayType: 'hyperspectral',
      overlayService: 'Wyvern',
      dataUrl: 'https://wyvern.space/open-data/',
      format: 'STAC',
      spectralBands: '20+',
      applications: ['vegetation', 'minerals', 'water quality'],
      documentation: 'https://wyvern.space/',
    },
  },
  // DEM/Terrain
  {
    content: 'Copernicus DEM (Digital Elevation Model)\nGlobal 30m and 90m resolution elevation data derived from TanDEM-X mission.',
    tags: ['overlay', 'dem', 'elevation', 'terrain', 'copernicus', 'layer'],
    metadata: {
      latitude: '40.7100',
      longitude: '-74.0180',
      city: 'Global',
      country: 'Global',
      source: 'widget-showcase',
      type: 'overlay',
      overlayType: 'dem',
      overlayService: 'Copernicus',
      awsUrl: 's3://copernicus-dem-30m/',
      format: 'COG',
      resolution: '30m/90m',
      coverage: 'Global',
      awsRegistry: 'https://registry.opendata.aws/copernicus-dem/',
      documentation: 'https://spacedata.copernicus.eu/collections/copernicus-digital-elevation-model',
    },
  },
  // Construction Site LiDAR - Hudson Yards
  {
    content: 'Construction Site LiDAR Survey - Hudson Yards Development\nHigh-density terrestrial LiDAR scan of active construction site. Weekly progress monitoring with volumetric analysis.',
    tags: ['overlay', 'lidar', 'pointcloud', 'construction', 'survey', 'urban', 'layer'],
    metadata: {
      latitude: '40.7540',
      longitude: '-74.0010',
      city: 'New York',
      country: 'USA',
      source: 'widget-showcase',
      type: 'overlay',
      overlayType: 'lidar',
      overlayService: 'Site Survey',
      format: 'E57/LAZ',
      resolution: '~50 points/m²',
      scanType: 'Terrestrial',
      updateFrequency: 'Weekly',
      pointCount: '450M',
    },
  },
  // Mining Volume LiDAR
  {
    content: 'Open Pit Mining Volume Analysis - Drone LiDAR Survey\nPrecision volumetric measurement for excavation progress tracking. RTK-enabled for centimeter accuracy.',
    tags: ['overlay', 'lidar', 'pointcloud', 'mining', 'volume', 'drone', 'layer'],
    metadata: {
      latitude: '40.7300',
      longitude: '-73.9500',
      city: 'Industrial Zone',
      country: 'USA',
      source: 'widget-showcase',
      type: 'overlay',
      overlayType: 'lidar',
      overlayService: 'Mining Survey',
      format: 'LAZ',
      resolution: '~100 points/m²',
      accuracy: '2cm horizontal, 1cm vertical',
      scanType: 'UAV',
      equipment: 'DJI Matrice 300 + Zenmuse L1',
    },
  },
  // Urban 3D Scan - Times Square
  {
    content: 'Urban 3D City Scan - Times Square District\nMobile LiDAR street-level scan for urban planning and BIM integration. Includes RGB texture mapping.',
    tags: ['overlay', 'lidar', 'pointcloud', '3d', 'urban', 'city', 'layer'],
    metadata: {
      latitude: '40.7580',
      longitude: '-73.9855',
      city: 'New York',
      country: 'USA',
      source: 'widget-showcase',
      type: 'overlay',
      overlayType: 'lidar',
      overlayService: 'Urban Scan',
      format: 'E57/LAS',
      resolution: '~200 points/m²',
      scanType: 'Mobile',
      textured: true,
      bimReady: true,
    },
  },
  // Bridge Infrastructure LiDAR
  {
    content: 'Brooklyn Bridge Infrastructure Assessment LiDAR\nDetailed structural LiDAR scan for bridge inspection and maintenance planning. Deformation monitoring enabled.',
    tags: ['overlay', 'lidar', 'pointcloud', 'bridge', 'infrastructure', 'inspection', 'layer'],
    metadata: {
      latitude: '40.7061',
      longitude: '-73.9969',
      city: 'New York',
      country: 'USA',
      source: 'widget-showcase',
      type: 'overlay',
      overlayType: 'lidar',
      overlayService: 'Infrastructure Survey',
      format: 'LAZ',
      resolution: '~500 points/m²',
      scanType: 'Static + Mobile',
      structuralAnalysis: true,
      deformationMonitoring: true,
    },
  },
  // Forest Canopy Analysis
  {
    content: 'Forest Canopy Height Model - Central Park\nAirborne LiDAR for vegetation structure analysis. Separates ground, understory, and canopy returns.',
    tags: ['overlay', 'lidar', 'pointcloud', 'forest', 'canopy', 'vegetation', 'layer'],
    metadata: {
      latitude: '40.7829',
      longitude: '-73.9654',
      city: 'New York',
      country: 'USA',
      source: 'widget-showcase',
      type: 'overlay',
      overlayType: 'lidar',
      overlayService: 'Forest Survey',
      format: 'LAZ',
      resolution: '~8 points/m²',
      classifications: ['Ground', 'Low Veg', 'Med Veg', 'High Veg'],
      chm: true,
      biomassEstimation: true,
    },
  },
  // Flood Plain Mapping
  {
    content: 'Coastal Flood Plain LiDAR - Lower Manhattan\nBare-earth DEM for flood modeling and sea level rise analysis. FEMA-compliant accuracy standards.',
    tags: ['overlay', 'lidar', 'pointcloud', 'dem', 'flood', 'coastal', 'terrain', 'layer'],
    metadata: {
      latitude: '40.7060',
      longitude: '-74.0088',
      city: 'New York',
      country: 'USA',
      source: 'widget-showcase',
      type: 'overlay',
      overlayType: 'dem',
      overlayService: 'FEMA Flood Map',
      format: 'LAZ',
      resolution: '~2 points/m²',
      accuracy: 'FEMA NFIP compliant',
      bareEarth: true,
      hydrologicallyEnforced: true,
    },
  },
  // Power Line Corridor Survey
  {
    content: 'Power Line Corridor LiDAR Survey - Transmission Lines\nVegetation encroachment analysis for utility maintenance. Automated wire and pole classification.',
    tags: ['overlay', 'lidar', 'pointcloud', 'powerline', 'utility', 'corridor', 'layer'],
    metadata: {
      latitude: '40.7400',
      longitude: '-73.9800',
      city: 'New York',
      country: 'USA',
      source: 'widget-showcase',
      type: 'overlay',
      overlayType: 'lidar',
      overlayService: 'Utility Survey',
      format: 'LAZ',
      resolution: '~15 points/m²',
      classifications: ['Ground', 'Wire', 'Pole', 'Vegetation'],
      vegetationAnalysis: true,
      clearanceCalculation: true,
    },
  },
];

// ============================================================================
// AI CHAT SHOWCASE DATA (Rich content for Q&A)
// ============================================================================

const AI_CHAT_DATA: WidgetShowcaseMemory[] = [
  {
    content: `Quarterly Sales Report - Northeast Region

Total revenue: $2.4M
Top performing areas: Manhattan ($890K), Brooklyn ($520K), Queens ($430K)
Key accounts: Acme Corp, TechStart Inc, Global Services Ltd
Trends: 15% YoY growth, strongest in financial services sector.
Challenges: Supply chain delays affecting 8% of deliveries.`,
    tags: ['report', 'sales', 'quarterly', 'northeast', 'location'],
    metadata: {
      latitude: '40.7580',
      longitude: '-73.9855',
      placeName: 'Northeast Regional HQ',
      city: 'New York',
      country: 'USA',
      source: 'widget-showcase',
      type: 'document',
      documentType: 'report',
      department: 'sales',
    },
  },
  {
    content: `Customer Incident Report - Central Park Area

Date: Recent
Location: 5th Avenue near Central Park entrance
Issue: Delivery delay due to street closure
Resolution: Rerouted via 6th Avenue, delivered 45 min late
Customer Impact: Moderate - compensation offered
Prevention: Updated routing algorithm to check real-time closures`,
    tags: ['incident', 'customer', 'delivery', 'location', 'area'],
    metadata: {
      latitude: '40.7644',
      longitude: '-73.9731',
      placeName: 'Central Park',
      city: 'New York',
      country: 'USA',
      source: 'widget-showcase',
      type: 'document',
      documentType: 'incident',
      severity: 'medium',
    },
  },
  {
    content: `Site Survey - Downtown Construction Zone

Survey Date: This week
Location: 123 Broadway, Lower Manhattan
Purpose: Assess feasibility for new distribution hub
Findings:
- Excellent highway access via FDR Drive
- Loading dock capacity for 6 trucks
- 24-hour operation permitted
- Zoning approved for commercial logistics
Recommendation: Proceed with lease negotiation`,
    tags: ['survey', 'site', 'construction', 'location', 'zone', 'area'],
    metadata: {
      latitude: '40.7074',
      longitude: '-74.0113',
      placeName: '123 Broadway',
      city: 'New York',
      country: 'USA',
      source: 'widget-showcase',
      type: 'document',
      documentType: 'survey',
      project: 'distribution-hub',
    },
  },
];

// ============================================================================
// MAIN SCRIPT
// ============================================================================

async function seedWidgetShowcaseData(): Promise<void> {
  const dbUrl = process.env.DATABASE_URL || 'postgresql://nexus:nexuspassword@localhost:5432/nexus';

  console.log('=== Widget Showcase Data Seeding Script ===\n');
  console.log('This script seeds data patterns to demonstrate all geo widgets:\n');
  console.log('  1. GeofenceMonitor - Security, safety, operational zones');
  console.log('  2. FleetTracker - Vehicles with various statuses');
  console.log('  3. HeatmapLayer - Clustered activity data');
  console.log('  4. GeoAIChatPanel - Rich documents for Q&A');
  console.log('');

  const pool = new Pool({ connectionString: dbUrl });

  try {
    // Test connection
    await pool.query('SELECT NOW()');
    console.log('✓ Database connection successful\n');

    // Check if memories table exists
    const tableCheck = await pool.query(`
      SELECT EXISTS (
        SELECT FROM information_schema.tables
        WHERE table_schema = 'graphrag'
        AND table_name = 'memories'
      );
    `);

    if (!tableCheck.rows[0].exists) {
      throw new Error('Table graphrag.memories does not exist. Run migrations first.');
    }
    console.log('✓ Table graphrag.memories exists\n');

    // Clear existing widget showcase data
    console.log('Clearing existing widget showcase data...');
    const deleteResult = await pool.query(`
      DELETE FROM graphrag.memories
      WHERE metadata->>'source' = 'widget-showcase'
    `);
    console.log(`✓ Cleared ${deleteResult.rowCount} existing showcase memories\n`);

    // Combine all showcase data
    const heatmapClusters = generateHeatmapClusters();
    const allMemories: WidgetShowcaseMemory[] = [
      ...GEOFENCE_ZONES,
      ...FLEET_ASSETS,
      ...heatmapClusters,
      ...AI_CHAT_DATA,
      ...OVERLAY_DATA,
    ];

    console.log(`Inserting ${allMemories.length} widget showcase memories...`);
    console.log(`  - ${GEOFENCE_ZONES.length} geofence zones`);
    console.log(`  - ${FLEET_ASSETS.length} fleet assets`);
    console.log(`  - ${heatmapClusters.length} heatmap cluster points`);
    console.log(`  - ${AI_CHAT_DATA.length} AI chat documents`);
    console.log(`  - ${OVERLAY_DATA.length} overlay layers (satellite, LiDAR, orthomosaic, hyperspectral)\n`);

    let insertedCount = 0;
    let errorCount = 0;

    for (const memory of allMemories) {
      try {
        await pool.query(
          `INSERT INTO graphrag.memories (content, tags, metadata, created_at)
           VALUES ($1, $2, $3, $4)`,
          [
            memory.content,
            memory.tags,
            JSON.stringify(memory.metadata),
            new Date(Date.now() - Math.random() * 7 * 24 * 60 * 60 * 1000), // Random date within last week
          ]
        );
        insertedCount++;

        if (insertedCount % 20 === 0) {
          console.log(`  Inserted ${insertedCount}/${allMemories.length} memories...`);
        }
      } catch (error) {
        errorCount++;
        console.error(`✗ Failed to insert memory: ${error}`);
      }
    }

    console.log(`\n✓ Successfully inserted ${insertedCount} showcase memories`);
    if (errorCount > 0) {
      console.log(`✗ Failed to insert ${errorCount} memories`);
    }

    // Summary statistics
    console.log('\n=== Summary ===\n');

    const geofenceCount = await pool.query(`
      SELECT COUNT(*) as count
      FROM graphrag.memories
      WHERE metadata->>'source' = 'widget-showcase'
      AND metadata->>'type' = 'geofence'
    `);
    console.log(`Geofence zones: ${geofenceCount.rows[0].count}`);

    const vehicleCount = await pool.query(`
      SELECT COUNT(*) as count
      FROM graphrag.memories
      WHERE metadata->>'source' = 'widget-showcase'
      AND metadata->>'type' = 'vehicle'
    `);
    console.log(`Fleet vehicles: ${vehicleCount.rows[0].count}`);

    const activityCount = await pool.query(`
      SELECT COUNT(*) as count
      FROM graphrag.memories
      WHERE metadata->>'source' = 'widget-showcase'
      AND metadata->>'type' = 'activity'
    `);
    console.log(`Activity points: ${activityCount.rows[0].count}`);

    const documentCount = await pool.query(`
      SELECT COUNT(*) as count
      FROM graphrag.memories
      WHERE metadata->>'source' = 'widget-showcase'
      AND metadata->>'type' = 'document'
    `);
    console.log(`Documents: ${documentCount.rows[0].count}`);

    console.log('\n=== Seeding Complete! ===\n');
    console.log('Test the widgets by opening the Data Explorer in nexus-dashboard.\n');

  } catch (error) {
    console.error('\n✗ Error during seeding:', error);
    process.exit(1);
  } finally {
    await pool.end();
    console.log('Database connection closed.');
  }
}

// Run the script
if (require.main === module) {
  seedWidgetShowcaseData()
    .then(() => process.exit(0))
    .catch((error) => {
      console.error('Fatal error:', error);
      process.exit(1);
    });
}

export { seedWidgetShowcaseData };
