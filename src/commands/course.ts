import { ChatInputCommandInteraction, SlashCommandBuilder, EmbedBuilder } from 'discord.js';
import axios from 'axios';

// Define the response structure from the API
interface CourseResponse {
  message: string;
  coursecode: string;
  course: string;
}

// Define a custom interface for axios errors
interface AxiosError {
  response?: {
    status: number;
    statusText: string;
  };
  message: string;
}

export const data = new SlashCommandBuilder()
  .setName('course')
  .setDescription('Get information about an Andamio course')
  .addStringOption(option => 
    option.setName('coursenftpolicyid')
      .setDescription('The Course NFT Policy Id to look up')
      .setRequired(true));

export async function execute(interaction: ChatInputCommandInteraction): Promise<void> {
  await interaction.deferReply();
  
  try {
    // Get the course NFT policy ID from the command options
    const courseNftPolicyId = interaction.options.getString('coursenftpolicyid', true);
    
    // Make the API request
    const response = await axios.get<CourseResponse>(`https://preprod.andamio.io/api/course/nft/${courseNftPolicyId}`);
    const courseData = response.data;
    
    // Create an embed with the course information
    const embed = new EmbedBuilder()
      .setColor('#0099ff')
      .setTitle(`Course: ${courseData.course}`)
      .addFields(
        { name: 'Course Code', value: courseData.coursecode, inline: true },
        { name: 'Course NFT Policy Id', value: courseNftPolicyId, inline: true },
        { name: 'Status', value: courseData.message, inline: true }
      )
      .setTimestamp()
      .setFooter({ text: 'Andamio Bot' });
    
    await interaction.editReply({ embeds: [embed] });
  } catch (error: unknown) {
    console.error('Error fetching course information:', error);
    
    // Check if it's an axios error by checking for the response property
    if (error && typeof error === 'object' && 'response' in error) {
      const axiosError = error as AxiosError;
      
      // Handle 404 errors specifically
      if (axiosError.response && axiosError.response.status === 404) {
        await interaction.editReply('Course not found. Please check the Course NFT Policy Id and try again.');
      } else {
        // Handle other axios errors
        const status = axiosError.response ? axiosError.response.status : 'Unknown';
        const statusText = axiosError.response ? axiosError.response.statusText : 'Unknown Error';
        await interaction.editReply(`Error: ${status} - ${statusText}`);
      }
    } else {
      // Handle non-axios errors
      await interaction.editReply('An error occurred while fetching the course information. Please try again later.');
    }
  }
}