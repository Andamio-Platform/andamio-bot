import { ChatInputCommandInteraction, SlashCommandBuilder, EmbedBuilder } from 'discord.js';
import axios from 'axios';

// Define the response structure from the API
interface LessonResponse {
  message: string;
  coursecode: string;
  modulecode: string;
  moduleindex: string;
  title: string;
  imageUrl: string | null;
  videoUrl: string;
  firstParagraphText: string;
  linkUrl: string;
}

// Define a custom interface for axios errors
interface AxiosError {
  response?: {
    status: number;
    statusText: string;
  };
  message: string;
}

// Default image URL to use if the lesson doesn't have an image
const DEFAULT_IMAGE_URL = 'https://app.andamio.io/images/sample-covers/1.jpg';

export const data = new SlashCommandBuilder()
  .setName('lesson')
  .setDescription('Get information about an Andamio lesson')
  .addStringOption(option => 
    option.setName('coursenftpolicyid')
      .setDescription('The Course NFT Policy Id to look up')
      .setRequired(true))
  .addStringOption(option => 
    option.setName('modulecode')
      .setDescription('The module code to look up')
      .setRequired(true))
  .addStringOption(option => 
    option.setName('moduleindex')
      .setDescription('The module index (lesson number) to look up')
      .setRequired(true));

export async function execute(interaction: ChatInputCommandInteraction): Promise<void> {
  await interaction.deferReply();
  
  try {
    // Get the parameters from the command options
    const courseNftPolicyId = interaction.options.getString('coursenftpolicyid', true);
    const moduleCode = interaction.options.getString('modulecode', true);
    const moduleIndex = interaction.options.getString('moduleindex', true);
    
    // Make the API request
    const response = await axios.get<LessonResponse>(
      `https://preprod.andamio.io/api/course/nft/${courseNftPolicyId}/${moduleCode}/${moduleIndex}`
    );
    const lessonData = response.data;
    
    // Create an embed with the lesson information
    const embed = new EmbedBuilder()
      .setColor('#0099ff')
      .setTitle(`Lesson: ${lessonData.title}`)
      .setDescription(lessonData.firstParagraphText)
      .addFields(
        { name: 'Course Code', value: lessonData.coursecode, inline: true },
        { name: 'Course NFT Policy Id', value: courseNftPolicyId, inline: true },
        { name: 'Module Code', value: lessonData.modulecode, inline: true },
        { name: 'Lesson Number', value: lessonData.moduleindex, inline: true },
        { name: 'Status', value: lessonData.message, inline: true }
      )
      .setTimestamp()
      .setFooter({ text: 'Andamio Bot' });
    
    // Add video URL if available
    if (lessonData.videoUrl && lessonData.videoUrl.trim() !== '') {
      embed.addFields({ name: 'Video', value: lessonData.videoUrl });
    }
    
    // Set the image URL (use the lesson's image if available, otherwise use the default)
    const imageUrl = lessonData.imageUrl || DEFAULT_IMAGE_URL;
    embed.setImage(imageUrl);
    
    // Add link to the lesson
    embed.addFields({ name: 'View Lesson', value: `[Click here to view the full lesson](${lessonData.linkUrl})` });
    
    await interaction.editReply({ embeds: [embed] });
  } catch (error: unknown) {
    console.error('Error fetching lesson information:', error);
    
    // Check if it's an axios error by checking for the response property
    if (error && typeof error === 'object' && 'response' in error) {
      const axiosError = error as AxiosError;
      
      // Handle 404 errors specifically
      if (axiosError.response && axiosError.response.status === 404) {
        await interaction.editReply('Lesson not found. Please check the Course NFT Policy Id, module code, and module index and try again.');
      } else {
        // Handle other axios errors
        const status = axiosError.response ? axiosError.response.status : 'Unknown';
        const statusText = axiosError.response ? axiosError.response.statusText : 'Unknown Error';
        await interaction.editReply(`Error: ${status} - ${statusText}`);
      }
    } else {
      // Handle non-axios errors
      await interaction.editReply('An error occurred while fetching the lesson information. Please try again later.');
    }
  }
}