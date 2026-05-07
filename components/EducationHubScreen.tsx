import { ScrollView, StyleSheet, Text, View } from 'react-native';
import { ResizeMode, Video } from 'expo-av';
import type { AVPlaybackSource } from 'expo-av';

type AqiLevel = {
  label: string;
  range: string;
  leftColor: string;
  advice: string[];
  actions: string[];
};

const sensitiveGroups = [
  'People with asthma, COPD, respiratory or other breathing conditions',
  'People with heart disease or those over 65 years old',
  'Children and teens, because lungs are still developing',
  'Pregnant people',
  'People who work or exercise heavily outdoors',
];

const levels: AqiLevel[] = [
  {
    label: 'Good',
    range: 'AQI 0-50',
    leftColor: '#00e400',
    advice: [
      'Air quality is satisfactory and health risk is minimal.',
      'No special precautions are needed for most people.',
      'Ideal conditions for outdoor activities and exercise.',
    ],
    actions: ['Enjoy outdoor activities', 'Keep windows open', 'Use bike/walk routes'],
  },
  {
    label: 'Moderate',
    range: 'AQI 51-100',
    leftColor: '#ffdb00',
    advice: [
      'Air quality is acceptable for most people.',
      'Very sensitive people may notice minor irritation with prolonged exposure.',
      'Most people can continue normal outdoor activity.',
    ],
    actions: ['Take breaks if sensitive', 'Watch for symptoms', 'Limit heavy exertion if needed'],
  },
  {
    label: 'Unhealthy for Sensitive Groups',
    range: 'AQI 101-150',
    leftColor: '#ff7e00',
    advice: [
      'Sensitive groups are at greater risk from prolonged exposure.',
      'People with asthma/COPD or heart disease may respond to symptoms sooner.',
      'Older adults and children should reduce prolonged outdoor exertion.',
    ],
    actions: ['Reduce prolonged exertion', 'Carry inhalers', 'Choose lower-traffic routes'],
  },
  {
    label: 'Unhealthy',
    range: 'AQI 151-200',
    leftColor: '#ff0000',
    advice: [
      'Everyone can begin to experience health effects.',
      'Sensitive groups may feel effects earlier and more intensely.',
      'Extended outdoor activity may worsen breathing and cardiovascular symptoms.',
    ],
    actions: ['Limit time outdoors', 'Use well-fitted masks', 'Run indoor air filtration'],
  },
  {
    label: 'Very Unhealthy',
    range: 'AQI 201-300',
    leftColor: '#8f3f97',
    advice: [
      'Health alert: risk is high for the entire population.',
      'Avoid prolonged or heavy outdoor activity.',
      'Children, older adults, and people with medical conditions should stay indoors.',
    ],
    actions: ['Stay indoors', 'Seal windows', 'Use HEPA filters'],
  },
  {
    label: 'Hazardous',
    range: 'AQI 301+',
    leftColor: '#7e0023',
    advice: [
      'Emergency conditions. Serious health impacts are likely.',
      'Avoid all outdoor exertion and remain indoors when possible.',
      'Follow local public health guidance and emergency alerts.',
    ],
    actions: ['Avoid outdoor exposure', 'Use clean air shelters', 'Follow emergency guidance'],
  },
];

type EducationVideo = {
  title: string;
  source: AVPlaybackSource;
};

const educationVideos: EducationVideo[] = [
  {
    title: 'AQI Basics Explained',
    source: require('../assets/videos/IMG_6354.mp4'),
  },
  {
    title: 'How Air Pollution Affects Health',
    source: require('../assets/videos/IMG_6356.mp4'),
  },
  {
    title: 'What Is PM2.5?',
    source: require('../assets/videos/IMG_6358.mp4'),
  },
  {
    title: 'Simple Steps To Protect Yourself',
    source: require('../assets/videos/IMG_6359.mp4'),
  },
];

function toPlaybackSource(source: AVPlaybackSource): AVPlaybackSource {
  if (typeof source === 'string') {
    return { uri: source };
  }
  return source;
}

export function EducationHubScreen() {
  return (
    <ScrollView contentContainerStyle={styles.content} style={styles.container}>
      <View style={styles.groupCard}>
        <Text style={styles.groupTitle}>Who counts as a sensitive group?</Text>
        {sensitiveGroups.map((group) => (
          <Text key={group} style={styles.groupItem}>
            {'\u2022'} {group}
          </Text>
        ))}
      </View>

      {levels.map((level) => (
        <View key={level.label} style={styles.levelCard}>
          <View style={[styles.levelLeft, { backgroundColor: level.leftColor }]}>
            <Text style={styles.levelLabel}>{level.label}</Text>
            <Text style={styles.levelRange}>{level.range}</Text>
          </View>
          <View style={styles.levelRight}>
            {level.advice.map((line) => (
              <Text key={`${level.label}-${line}`} style={styles.adviceLine}>
                {'\u2022'} {line}
              </Text>
            ))}
            <View style={styles.actionWrap}>
              {level.actions.map((action) => (
                <View key={`${level.label}-${action}`} style={styles.actionChip}>
                  <Text style={styles.actionChipText}>{action}</Text>
                </View>
              ))}
            </View>
          </View>
        </View>
      ))}

      <View style={styles.pmCard}>
        <Text style={styles.pmTitle}>About PM2.5</Text>
        <Text style={styles.pmBody}>
          PM2.5 are fine particles small enough to travel deep into the lungs and sometimes into the bloodstream.
          Common sources include wildfire smoke, traffic emissions, industry, and burning fuels.
        </Text>
        <Text style={styles.pmBody}>
          Even short-term exposure can worsen asthma and heart symptoms. Long-term exposure is linked to higher
          risk of respiratory and cardiovascular disease.
        </Text>
      </View>

      <View style={styles.videoSection}>
        <Text style={styles.videoSectionTitle}>Video Learning</Text>
        <Text style={styles.videoSectionSubtitle}>Watch these quick explainers on AQI, PM2.5, and air-safety habits.</Text>
        {educationVideos.map((video) => (
          <View key={video.source} style={styles.videoCard}>
            <Text style={styles.videoTitle}>{video.title}</Text>
            <View style={styles.videoFrame}>
              <Video
                source={toPlaybackSource(video.source)}
                style={styles.videoPlayer}
                useNativeControls
                resizeMode={ResizeMode.COVER}
                isLooping={false}
              />
            </View>
          </View>
        ))}
      </View>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#f3f4f6',
  },
  content: {
    padding: 12,
    gap: 10,
  },
  groupCard: {
    backgroundColor: '#f8f2df',
    borderWidth: 1,
    borderColor: '#e2d6b2',
    borderRadius: 10,
    padding: 12,
  },
  groupTitle: {
    fontSize: 15,
    fontWeight: '800',
    color: '#1f2937',
    marginBottom: 8,
  },
  groupItem: {
    fontSize: 13,
    color: '#374151',
    lineHeight: 19,
    marginBottom: 2,
  },
  levelCard: {
    backgroundColor: '#ffffff',
    borderWidth: 1,
    borderColor: '#d1d5db',
    borderRadius: 10,
    flexDirection: 'row',
    overflow: 'hidden',
  },
  levelLeft: {
    width: 92,
    minHeight: 120,
    justifyContent: 'center',
    alignItems: 'center',
    paddingHorizontal: 8,
  },
  levelLabel: {
    fontSize: 16,
    fontWeight: '800',
    color: '#0f172a',
    textAlign: 'center',
  },
  levelRange: {
    fontSize: 11,
    fontWeight: '700',
    color: '#0f172a',
    marginTop: 4,
    textAlign: 'center',
  },
  levelRight: {
    flex: 1,
    padding: 10,
    gap: 4,
  },
  adviceLine: {
    fontSize: 12.5,
    color: '#334155',
    lineHeight: 18,
  },
  actionWrap: {
    marginTop: 6,
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 6,
  },
  actionChip: {
    borderWidth: 1,
    borderColor: '#cbd5e1',
    borderRadius: 999,
    paddingHorizontal: 9,
    paddingVertical: 4,
    backgroundColor: '#f8fafc',
  },
  actionChipText: {
    fontSize: 11,
    fontWeight: '600',
    color: '#475569',
  },
  pmCard: {
    backgroundColor: '#ffffff',
    borderWidth: 1,
    borderColor: '#d1d5db',
    borderRadius: 10,
    padding: 12,
    marginBottom: 14,
  },
  pmTitle: {
    fontSize: 18,
    fontWeight: '800',
    color: '#0f172a',
    marginBottom: 8,
  },
  pmBody: {
    fontSize: 13,
    lineHeight: 20,
    color: '#374151',
    marginBottom: 6,
  },
  videoSection: {
    backgroundColor: '#ffffff',
    borderWidth: 1,
    borderColor: '#d1d5db',
    borderRadius: 10,
    padding: 12,
    marginBottom: 18,
    gap: 10,
  },
  videoSectionTitle: {
    fontSize: 18,
    fontWeight: '800',
    color: '#0f172a',
  },
  videoSectionSubtitle: {
    fontSize: 12.5,
    lineHeight: 18,
    color: '#475569',
  },
  videoCard: {
    borderWidth: 1,
    borderColor: '#e2e8f0',
    borderRadius: 10,
    padding: 8,
    backgroundColor: '#f8fafc',
  },
  videoTitle: {
    fontSize: 14,
    fontWeight: '700',
    color: '#1e293b',
    marginBottom: 6,
  },
  videoFrame: {
    borderRadius: 8,
    overflow: 'hidden',
    height: 200,
    backgroundColor: '#000000',
  },
  videoPlayer: {
    flex: 1,
    backgroundColor: '#000000',
  },
});
